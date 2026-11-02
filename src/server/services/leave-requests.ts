import type { Actor } from "@/domain/actor";
import { type ApprovalRule, ManagerApprovalRule } from "@/domain/approval-rule";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { fromEpochDay, toEpochDay } from "@/domain/calendar-date";
import { nextWorkingDay, requireLeaveDays, WORKING_DAY_LOOKAHEAD } from "@/domain/leave-days";
import { canCancel } from "@/domain/leave-permissions";
import {
  assertValidRange,
  type DayPortion,
  type LeaveRange,
  normalizeNote,
  rangesOverlap,
} from "@/domain/leave-request";
import { assertTransition } from "@/domain/request-status";
import { todayInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { findCompanySettings, listHolidayDates } from "@/server/repositories/calendar";
import {
  countRecentRequests,
  findLeaveRequest,
  insertLeaveRequest,
  type LeaveRequestRow,
  listActiveRequestsInRange,
  listRequestsForUser,
  updateStatusIfCurrent,
} from "@/server/repositories/leave-requests";
import { findActiveLeaveType, findLeaveType, listActiveLeaveTypes } from "@/server/repositories/leave-types";
import { findMember, listActiveAdmins, lockMember } from "@/server/repositories/users";
import { activeContacts, recordLeaveChange, summarize } from "./leave-changes";
import { commitThenNotify, type Outgoing } from "./notify";

/** What a person fills in to ask for time off. */
export interface SubmitLeaveInput {
  leaveTypeId: string;
  startDate: string;
  /** Defaults to `startDate` when empty. */
  endDate?: string | null;
  dayPortion: DayPortion;
  note?: string | null;
}

/** How many of a person's requests the dashboard lists. */
const DASHBOARD_REQUEST_LIMIT = 50;

/**
 * Most requests one person may submit per {@link SUBMIT_WINDOW_MINUTES}, counting
 * ones since cancelled. Each submit can email an approver, and each cancel of it
 * emails them again, so this also caps how much mail one person can cause.
 */
export const SUBMIT_LIMIT = 10;
export const SUBMIT_WINDOW_MINUTES = 10;

/**
 * Submits a leave request for the actor and routes it for approval.
 *
 * Days are counted here from the company's working days and holidays, never taken
 * from input. The request is approved on the spot when the approval rule says so
 * (self-approval); otherwise it waits for the approver it was routed to. Every
 * transition writes `audit_log` and `events_outbox` rows in the same transaction, and
 * emails go out only after commit.
 *
 * @returns The stored request in its final state (`pending` or `approved`).
 * @throws DomainError `invalid_input`, `invalid_date_range`, `range_too_long`,
 *   `half_day_multi_day`, `zero_days`, `leave_type_unavailable`,
 *   `overlapping_request`, `no_approver`, `rate_limited` (more than {@link SUBMIT_LIMIT}
 *   in {@link SUBMIT_WINDOW_MINUTES} minutes), or `forbidden` for an inactive requester.
 */
export async function submitLeaveRequest(
  ctx: ServiceContext,
  actor: Actor,
  input: SubmitLeaveInput,
  rule: ApprovalRule = new ManagerApprovalRule(),
): Promise<LeaveRequestRow> {
  const range: LeaveRange = {
    startDate: input.startDate,
    endDate: input.endDate || input.startDate,
    dayPortion: input.dayPortion,
  };
  assertValidRange(range);
  const note = normalizeNote(input.note);
  if (!isUuid(input.leaveTypeId)) throw new DomainError("leave_type_unavailable");

  return commitThenNotify(ctx, async (tx) => {
    const requester = await lockMember(tx, actor.companyId, actor.id);
    if (!requester?.isActive) throw new DomainError("forbidden");
    // Counted under the member lock, so parallel submits cannot all slip under the cap.
    if ((await countRecentRequests(tx, actor.id, SUBMIT_WINDOW_MINUTES)) >= SUBMIT_LIMIT) {
      throw new DomainError("rate_limited");
    }

    const leaveType = await findActiveLeaveType(tx, actor.companyId, input.leaveTypeId);
    if (!leaveType) throw new DomainError("leave_type_unavailable");

    const settings = await findCompanySettings(tx, actor.companyId);
    if (!settings) throw new DomainError("no_company");
    const holidays = await listHolidayDates(tx, actor.companyId, range.startDate, range.endDate);
    const days = requireLeaveDays(range, { workingDays: settings.workingDays, holidays });

    const existing = await listActiveRequestsInRange(tx, actor.id, range.startDate, range.endDate);
    if (existing.some((other) => rangesOverlap(range, other))) throw new DomainError("overlapping_request");

    const manager =
      requester.managerId && requester.managerId !== requester.id
        ? ((await findMember(tx, actor.companyId, requester.managerId)) ?? null)
        : null;
    const admins = await listActiveAdmins(tx, actor.companyId);
    const decision = rule.resolve({ requester, manager, admins });

    const created = await insertLeaveRequest(tx, {
      companyId: actor.companyId,
      userId: actor.id,
      leaveTypeId: leaveType.id,
      ...range,
      days,
      note,
      status: "pending",
      approverId: decision.approverId,
    });
    await recordLeaveChange(tx, { event: "requested", before: null, after: created, actorId: actor.id });

    let final = created;
    if (decision.kind === "auto_approve") {
      assertTransition("pending", "approved");
      const approved = await updateStatusIfCurrent(
        tx,
        { companyId: actor.companyId, id: created.id, from: "pending" },
        { status: "approved", decidedAt: ctx.now() },
      );
      if (!approved) throw new DomainError("conflict");
      await recordLeaveChange(tx, { event: "approved", before: created, after: approved, actorId: actor.id });
      final = approved;
    }

    const contacts = await activeContacts(tx, actor.companyId, [actor.id, decision.approverId]);
    const me = contacts.get(actor.id);
    const approver = contacts.get(decision.approverId);
    const leave = summarize(final, me, leaveType.name);
    const mail: Outgoing[] = [];
    if (decision.kind === "auto_approve") {
      if (me) {
        mail.push({ to: me.email, email: { kind: "approved", recipientName: me.name, leave, reason: null, link: `${ctx.appUrl}/` } });
      }
    } else if (approver && approver.id !== actor.id) {
      mail.push({
        to: approver.email,
        email: { kind: "requested", recipientName: approver.name, leave, link: `${ctx.appUrl}/approvals` },
      });
    }
    return { result: final, outgoing: mail };
  });
}

/**
 * Cancels one of the actor's own requests, pending or already approved.
 *
 * Emails the requester, and the approver too unless the approver is the person
 * cancelling (a self-approved request).
 *
 * @throws DomainError `not_found`, `forbidden` (not the requester),
 *   `invalid_transition` (already rejected or cancelled), or `conflict` when the
 *   request changed concurrently.
 */
export async function cancelLeaveRequest(ctx: ServiceContext, actor: Actor, requestId: string): Promise<LeaveRequestRow> {
  if (!isUuid(requestId)) throw new DomainError("not_found");

  return commitThenNotify(ctx, async (tx) => {
    const before = await findLeaveRequest(tx, actor.companyId, requestId);
    if (!before) throw new DomainError("not_found");
    if (!canCancel(actor, before)) throw new DomainError("forbidden");
    assertTransition(before.status, "cancelled");

    const after = await updateStatusIfCurrent(
      tx,
      { companyId: actor.companyId, id: before.id, from: before.status },
      { status: "cancelled" },
    );
    if (!after) throw new DomainError("conflict");
    await recordLeaveChange(tx, { event: "cancelled", before, after, actorId: actor.id });

    const contacts = await activeContacts(tx, actor.companyId, [after.userId, after.approverId]);
    const leaveType = await findLeaveType(tx, actor.companyId, after.leaveTypeId);
    const requester = contacts.get(after.userId);
    const leave = summarize(after, requester, leaveType?.name ?? "Time off");
    const mail: Outgoing[] = [];
    if (requester) {
      mail.push({
        to: requester.email,
        email: { kind: "cancelled_requester", recipientName: requester.name, leave, link: `${ctx.appUrl}/` },
      });
    }
    const approver = after.approverId ? contacts.get(after.approverId) : undefined;
    if (approver && approver.id !== actor.id) {
      mail.push({
        to: approver.email,
        email: { kind: "cancelled_approver", recipientName: approver.name, leave, link: `${ctx.appUrl}/approvals` },
      });
    }
    return { result: after, outgoing: mail };
  });
}

/** Everything the dashboard renders for the actor, in one call. */
export async function getDashboard(ctx: ServiceContext, actor: Actor) {
  const [settings, leaveTypes, requests] = await Promise.all([
    findCompanySettings(ctx.db, actor.companyId),
    listActiveLeaveTypes(ctx.db, actor.companyId),
    listRequestsForUser(ctx.db, actor.companyId, actor.id, DASHBOARD_REQUEST_LIMIT),
  ]);
  const today = todayInTimeZone(settings?.timezone ?? "UTC", ctx.now());
  const lookaheadEnd = fromEpochDay(toEpochDay(today) + WORKING_DAY_LOOKAHEAD - 1);
  const holidays = await listHolidayDates(ctx.db, actor.companyId, today, lookaheadEnd);
  return {
    /**
     * The form's default start date: the first working day from today (in the
     * company's time zone), so the pre-filled request is never worth zero days.
     */
    defaultDate: nextWorkingDay(today, { workingDays: settings?.workingDays ?? [], holidays }),
    leaveTypes,
    requests,
  };
}

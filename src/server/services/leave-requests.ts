import type { Actor } from "@/domain/actor";
import { type ApprovalRule, ManagerApprovalRule } from "@/domain/approval-rule";
import { fromEpochDay, toEpochDay } from "@/domain/calendar-date";
import { DomainError, isDomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { nextWorkingDay, WORKING_DAY_LOOKAHEAD } from "@/domain/leave-days";
import { canCancel } from "@/domain/leave-permissions";
import { assertValidRange, normalizeNote } from "@/domain/leave-request";
import { assertCancellableOn, assertTransition, canCancelOn } from "@/domain/request-status";
import { todayInTimeZone, yearInTimeZone } from "@/lib/dates";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { insertRequestDays } from "@/server/repositories/balances";
import { findCompanySettings, listHolidayDates } from "@/server/repositories/calendar";
import {
  countRecentRequests,
  findLeaveRequest,
  insertLeaveRequest,
  type LeaveRequestRow,
  listRequestsForUser,
  updateStatusIfCurrent,
} from "@/server/repositories/leave-requests";
import { findLeaveType, listLeaveTypesWithAllowance } from "@/server/repositories/leave-types";
import { findMember, listActiveAdmins, lockMember } from "@/server/repositories/users";
import { assessLeaveRequest, draftRange, type LeaveDraft, summarizeBalances } from "./balances";
import { activeContacts, recordLeaveChange, summarize } from "./leave-changes";
import { commitThenNotify, type Outgoing } from "./notify";

/** What a person fills in to ask for time off. */
export interface SubmitLeaveInput extends LeaveDraft {
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
 * from input, by {@link assessLeaveRequest}: the same function the live preview runs,
 * so submit decides exactly what the preview showed. A tracked leave type's balance
 * must cover the request in every calendar year it touches, self-approved or not.
 * The requester's row lock serialises their submits, so two sent at once cannot
 * spend the same days. What the request costs per year is stored with it
 * (`leave_request_days`), so later holiday edits never change a past balance.
 *
 * The request is approved on the spot when the approval rule says so (self-approval);
 * otherwise it waits for the approver it was routed to. Every transition writes
 * `audit_log` and `events_outbox` rows in the same transaction, and emails go out only
 * after commit.
 *
 * @returns The stored request in its final state (`pending` or `approved`).
 * @throws DomainError as {@link assessLeaveRequest} (including `insufficient_balance`),
 *   plus `no_approver`, `rate_limited` (more than {@link SUBMIT_LIMIT} in
 *   {@link SUBMIT_WINDOW_MINUTES} minutes), or `forbidden` for an inactive requester.
 */
export async function submitLeaveRequest(
  ctx: ServiceContext,
  actor: Actor,
  input: SubmitLeaveInput,
  rule: ApprovalRule = new ManagerApprovalRule(),
): Promise<LeaveRequestRow> {
  // Cheap checks first, so malformed input never opens a transaction.
  assertValidRange(draftRange(input));
  const note = normalizeNote(input.note);
  if (!isUuid(input.leaveTypeId)) throw new DomainError("leave_type_unavailable");

  return commitThenNotify(ctx, async (tx) => {
    const requester = await lockMember(tx, actor.companyId, actor.id);
    if (!requester?.isActive) throw new DomainError("forbidden");
    // Counted under the member lock, so parallel submits cannot all slip under the cap.
    if ((await countRecentRequests(tx, actor.id, SUBMIT_WINDOW_MINUTES)) >= SUBMIT_LIMIT) {
      throw new DomainError("rate_limited");
    }

    const assessment = await assessLeaveRequest(tx, actor, input);
    const { leaveType } = assessment;

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
      ...assessment.range,
      days: assessment.days,
      note,
      status: "pending",
      approverId: decision.approverId,
    });
    await insertRequestDays(tx, created.id, assessment.charges);
    await recordLeaveChange(tx, { event: "requested", before: null, after: created, source: actor.source });

    let final = created;
    if (decision.kind === "auto_approve") {
      assertTransition("pending", "approved");
      const approved = await updateStatusIfCurrent(
        tx,
        { companyId: actor.companyId, id: created.id, from: "pending" },
        { status: "approved", decidedAt: ctx.now() },
      );
      if (!approved) throw new DomainError("conflict");
      await recordLeaveChange(tx, { event: "approved", before: created, after: approved, source: actor.source });
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
 * Cancels one of the actor's own requests, pending or already approved, unless it is
 * approved leave of a closed year (it ended before January 1 in the company's time
 * zone; see `isClosedYearLeave`), which nobody may cancel.
 *
 * Emails the requester, and the approver too unless the approver is the person
 * cancelling (a self-approved request).
 *
 * @throws DomainError `not_found`, `forbidden` (not the requester),
 *   `invalid_transition` (already rejected or cancelled), `past_year_closed`, or
 *   `conflict` when the request changed concurrently.
 */
export async function cancelLeaveRequest(ctx: ServiceContext, actor: Actor, requestId: string): Promise<LeaveRequestRow> {
  if (!isUuid(requestId)) throw new DomainError("not_found");

  return commitThenNotify(ctx, async (tx) => {
    const before = await findLeaveRequest(tx, actor.companyId, requestId);
    if (!before) throw new DomainError("not_found");
    if (!canCancel(actor, before)) throw new DomainError("forbidden");
    const settings = await findCompanySettings(tx, actor.companyId);
    if (!settings) throw new DomainError("no_company");
    assertCancellableOn(before, todayInTimeZone(settings.timezone, ctx.now()));

    const after = await updateStatusIfCurrent(
      tx,
      { companyId: actor.companyId, id: before.id, from: before.status },
      { status: "cancelled" },
    );
    if (!after) throw new DomainError("conflict");
    await recordLeaveChange(tx, { event: "cancelled", before, after, source: actor.source });

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

/**
 * Everything the dashboard renders for the actor, in one call, in six queries
 * whatever the number of types or requests:
 * company settings, leave types and the actor's requests in parallel; then
 * the balances' allowance rows and booked-day sums, and the look-ahead holidays, in
 * parallel. The form's leave types and the balances share the one leave-type read.
 *
 * `balances` is `null` when the company's allowance policy is unknown. That is logged
 * as `allowance_policy_unavailable` and the rest of the dashboard still renders;
 * submitting and previewing refuse with `policy_unavailable` instead.
 *
 * @throws DomainError `no_company` when the actor's company is missing.
 */
export async function getDashboard(ctx: ServiceContext, actor: Actor) {
  const [settings, types, requests] = await Promise.all([
    findCompanySettings(ctx.db, actor.companyId),
    listLeaveTypesWithAllowance(ctx.db, actor.companyId),
    listRequestsForUser(ctx.db, actor.companyId, actor.id, DASHBOARD_REQUEST_LIMIT),
  ]);
  if (!settings) throw new DomainError("no_company");
  const now = ctx.now();
  const today = todayInTimeZone(settings.timezone, now);
  const lookaheadEnd = fromEpochDay(toEpochDay(today) + WORKING_DAY_LOOKAHEAD - 1);
  const [balances, holidays] = await Promise.all([
    summarizeBalances(ctx.db, actor, {
      allowancePolicy: settings.allowancePolicy,
      types,
      year: yearInTimeZone(settings.timezone, now),
    }).catch((err: unknown) => {
      if (!isDomainError(err, "policy_unavailable")) throw err;
      log.error({ err, companyId: actor.companyId }, "allowance_policy_unavailable");
      return null;
    }),
    listHolidayDates(ctx.db, actor.companyId, today, lookaheadEnd),
  ]);
  return {
    /**
     * The person's requests, each with whether it can be cancelled today: the status
     * machine allows it and it is not approved leave of a closed year.
     */
    requests: requests.map((r) => ({ ...r, cancellable: canCancelOn(r, today) })),
    /**
     * The form's default start date: the first working day from today (in the
     * company's time zone), so the pre-filled request is never worth zero days.
     */
    defaultDate: nextWorkingDay(today, { workingDays: settings.workingDays, holidays }),
    /** Active leave types in display order; the first is the form's default. */
    leaveTypes: types.filter((t) => !t.archived).map(({ id, name, code, color }) => ({ id, name, code, color })),
    balances,
  };
}

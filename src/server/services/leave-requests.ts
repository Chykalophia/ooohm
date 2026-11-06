import type { Actor } from "@/domain/actor";
import { addDays, isEmptyBalance, resolveAllowancePolicy } from "@/domain/allowance-policy";
import { type ApprovalRule, approvalRuleFor, readApprovalMode } from "@/domain/approval-rule";
import { fromEpochDay, isCalendarDate, toEpochDay } from "@/domain/calendar-date";
import { DomainError, isDomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { isCursorInstant, type PageCursor, readPage } from "@/domain/paging";
import { nextWorkingDay, WORKING_DAY_LOOKAHEAD } from "@/domain/leave-days";
import { canCancel } from "@/domain/leave-permissions";
import { assertValidRange, normalizeNote } from "@/domain/leave-request";
import { assertCancellableOn, assertTransition, canCancelOn } from "@/domain/request-status";
import { todayInTimeZone, yearInTimeZone } from "@/lib/dates";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { insertRequestDays } from "@/server/repositories/balances";
import { findCompanySettings, listHolidayDates } from "@/server/repositories/calendar";
import { shareLockCompany } from "@/server/repositories/companies";
import {
  countRecentRequests,
  lockLeaveRequest,
  insertLeaveRequest,
  type LeaveRequestRow,
  findRequestOfUser,
  listRequestsForUser,
  medianDecisionHours,
  updateStatusIfCurrent,
} from "@/server/repositories/leave-requests";
import { findLeaveType, listLeaveTypesWithAllowance } from "@/server/repositories/leave-types";
import { findDepartment } from "@/server/repositories/departments";
import { findMember, findPerson, listActiveAdmins, lockMember } from "@/server/repositories/users";
import { currentApprover } from "./approvals";
import { approveLinkFor } from "./email-approval";
import { assessLeaveRequest, draftRange, type LeaveDraft, summarizeBalances } from "./balances";
import { alsoOffFor } from "./also-off";
import { activeContacts, recordLeaveChange, summarize } from "./leave-changes";
import { commitThenNotify, type Outgoing } from "./notify";

/** What a person fills in to ask for time off. */
export interface SubmitLeaveInput extends LeaveDraft {
  note?: string | null;
}

/** Requests per page of "Your requests". */
export const REQUESTS_PAGE_SIZE = 10;

/** How many of a person's requests the dashboard shows; the rest are on "Your requests". */
export const DASHBOARD_REQUESTS = 5;

/** A requests page's key: `[start_date, created_at, id]`. */
const REQUEST_KEY = [isCalendarDate, isCursorInstant, isUuid] as const;

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
 * The company's approval mode picks the rule ({@link approvalRuleFor}) unless `rule` is
 * given. The request is approved on the spot when the rule says so (self-approval, or
 * every request while approval is turned off, when the person's manager is told
 * instead of asked); otherwise it waits for the approver it was routed to. Every transition writes
 * `audit_log` and `events_outbox` rows in the same transaction, and emails go out only
 * after commit.
 *
 * @returns The stored request in its final state (`pending` or `approved`), with
 *   `headsUp`: it was booked because approval is turned off, not approved by anyone.
 * @throws DomainError as {@link assessLeaveRequest} (including `insufficient_balance`),
 *   plus `no_approver`, `rate_limited` (more than {@link SUBMIT_LIMIT} in
 *   {@link SUBMIT_WINDOW_MINUTES} minutes), or `forbidden` for an inactive requester.
 */
export async function submitLeaveRequest(
  ctx: ServiceContext,
  actor: Actor,
  input: SubmitLeaveInput,
  rule?: ApprovalRule,
): Promise<LeaveRequestRow & { headsUp: boolean }> {
  // Cheap checks first, so malformed input never opens a transaction.
  assertValidRange(draftRange(input));
  const note = normalizeNote(input.note);
  if (!isUuid(input.leaveTypeId)) throw new DomainError("leave_type_unavailable");

  return commitThenNotify(ctx, async (tx) => {
    // Shared with other submits, exclusive with a holiday or working-days change, which
    // recounts submitted requests: a request is never counted with a calendar that is
    // being replaced. Taken before the member lock, the order every service locks in.
    await shareLockCompany(tx, actor.companyId);
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
    const [admins, settings] = await Promise.all([listActiveAdmins(tx, actor.companyId), findCompanySettings(tx, actor.companyId)]);
    if (!settings) throw new DomainError("no_company");
    const decision = (rule ?? approvalRuleFor(readApprovalMode(settings.approvalMode))).resolve({ requester, manager, admins });
    const informId = decision.kind === "auto_approve" ? (decision.informId ?? null) : null;
    const headsUp = decision.kind === "auto_approve" && decision.informId !== undefined;

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

    const contacts = await activeContacts(tx, actor.companyId, [actor.id, decision.approverId, ...(informId ? [informId] : [])]);
    const me = contacts.get(actor.id);
    const approver = contacts.get(decision.approverId);
    const told = informId ? contacts.get(informId) : undefined;
    const leave = summarize(final, me, leaveType.name);
    const mail: Outgoing[] = [];
    // Who else is off, scoped to the requester's department as on the Approvals page.
    const alsoOffLine = async () => {
      const person = await findPerson(tx, actor.companyId, actor.id);
      const department = person?.departmentId ? await findDepartment(tx, actor.companyId, person.departmentId) : undefined;
      const request = { ...final, userId: actor.id, departmentId: department?.id ?? null, departmentName: department?.name ?? null };
      return (await alsoOffFor(tx, actor.companyId, [request])).get(final.id)?.line ?? null;
    };
    if (headsUp) {
      if (me) mail.push({ to: me.email, email: { kind: "booked", recipientName: me.name, leave, link: `${ctx.appUrl}/` } });
      if (told) {
        mail.push({
          to: told.email,
          email: { kind: "heads_up", recipientName: told.name, leave, alsoOff: await alsoOffLine(), link: `${ctx.appUrl}/calendar` },
        });
      }
    } else if (decision.kind === "auto_approve") {
      if (me) {
        mail.push({ to: me.email, email: { kind: "approved", recipientName: me.name, leave, reason: null, link: `${ctx.appUrl}/` } });
      }
    } else if (approver && approver.id !== actor.id) {
      const alsoOff = await alsoOffLine();
      mail.push({
        to: approver.email,
        email: {
          kind: "requested",
          recipientName: approver.name,
          leave,
          alsoOff,
          link: `${ctx.appUrl}/approvals`,
          approveLink: approveLinkFor(ctx, final.id, approver.id),
        },
      });
    }
    return { result: { ...final, headsUp }, outgoing: mail };
  });
}

/**
 * Cancels one of the actor's own requests, pending or already approved, unless it is
 * approved leave of a closed year (it ended before January 1 in the company's time
 * zone; see `isClosedYearLeave`), which nobody may cancel.
 *
 * Emails the requester, and the approver too unless the approver is the person
 * cancelling (a self-approved request). While approval is turned off, someone
 * cancelling time off they booked themself also tells whoever was told about it
 * (their manager now, else the fallback admin; see {@link currentApprover}).
 *
 * @throws DomainError `not_found`, `forbidden` (not the requester),
 *   `invalid_transition` (already rejected or cancelled), `past_year_closed`, or
 *   `conflict` when the request changed concurrently.
 */
export async function cancelLeaveRequest(ctx: ServiceContext, actor: Actor, requestId: string): Promise<LeaveRequestRow> {
  if (!isUuid(requestId)) throw new DomainError("not_found");

  return commitThenNotify(ctx, async (tx) => {
    const before = await lockLeaveRequest(tx, actor.companyId, requestId);
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
    let approver = after.approverId ? contacts.get(after.approverId) : undefined;
    if (readApprovalMode(settings.approvalMode) === "heads_up" && after.approverId === after.userId) {
      const toldId = await currentApprover(tx, actor.companyId, after.userId);
      approver = toldId && toldId !== after.userId ? (await activeContacts(tx, actor.companyId, [toldId])).get(toldId) : undefined;
    }
    if (approver && approver.id !== actor.id) {
      mail.push({
        to: approver.email,
        email: { kind: "cancelled_approver", recipientName: approver.name, leave, link: `${ctx.appUrl}/approvals` },
      });
    }
    return { result: after, outgoing: mail };
  });
}

/** When Home starts saying which days won't carry into next year (month and day). */
const EXPIRY_NUDGE_FROM = "11-01";

/**
 * A page of the actor's own requests for "Your requests", latest dates first, each with
 * whether it can be cancelled today ({@link canCancelOn}): the company (its time zone,
 * for today) and the page, in parallel.
 *
 * @param page From a previous page's `previous` or `next`; the first page when absent.
 * @throws DomainError `no_company`.
 */
export async function listMyRequests(ctx: ServiceContext, actor: Actor, page?: PageCursor) {
  const [settings, requests] = await Promise.all([
    findCompanySettings(ctx.db, actor.companyId),
    readPage({
      cursor: page,
      size: REQUESTS_PAGE_SIZE,
      checks: REQUEST_KEY,
      read: (request, limit) => listRequestsForUser(ctx.db, actor.companyId, actor.id, limit, request),
      keyOf: (r) => [r.startDate, r.cursor, r.id],
    }),
  ]);
  if (!settings) throw new DomainError("no_company");
  const today = todayInTimeZone(settings.timezone, ctx.now());
  return {
    items: requests.items.map((r) => ({ ...r, cancellable: canCancelOn(r, today) })),
    previous: requests.previous,
    next: requests.next,
  };
}

/**
 * One of the actor's own requests in full, for its own page: the leave, who decides it
 * and what they said, when it was sent and decided (with the company's time zone to
 * show those in), and whether it can be cancelled today.
 *
 * @throws DomainError `not_found` (not a request of theirs, someone else's included),
 *   `no_company`.
 */
export async function getMyRequest(ctx: ServiceContext, actor: Actor, id: string) {
  if (!isUuid(id)) throw new DomainError("not_found");
  const [settings, request] = await Promise.all([
    findCompanySettings(ctx.db, actor.companyId),
    findRequestOfUser(ctx.db, actor.companyId, actor.id, id),
  ]);
  if (!settings) throw new DomainError("no_company");
  if (!request) throw new DomainError("not_found");
  const today = todayInTimeZone(settings.timezone, ctx.now());
  return { request: { ...request, cancellable: canCancelOn(request, today) }, timezone: settings.timezone };
}

/** How far back "usually decides within…" looks, and how many decisions it needs first. */
const TYPICAL_WAIT_DAYS = 180;
const TYPICAL_WAIT_MIN_DECISIONS = 3;

/**
 * Everything the dashboard renders for the actor, in one call, in six queries
 * whatever the number of types or requests (seven while one of its latest few requests waits
 * on someone):
 * company settings, leave types and the actor's requests in parallel; then
 * the balances' allowance rows and booked-day sums, the look-ahead holidays and, for
 * pending requests, their approvers' usual decision times, in parallel. The form's leave types and the balances share the one leave-type read.
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
    // One more than shown, to know whether "Your requests" holds more.
    listRequestsForUser(ctx.db, actor.companyId, actor.id, DASHBOARD_REQUESTS + 1),
  ]);
  if (!settings) throw new DomainError("no_company");
  const now = ctx.now();
  const today = todayInTimeZone(settings.timezone, now);
  const lookaheadEnd = fromEpochDay(toEpochDay(today) + WORKING_DAY_LOOKAHEAD - 1);
  const shown = requests.slice(0, DASHBOARD_REQUESTS);
  // Who has each of my pending requests, and how long they usually take to decide.
  const waitingOn = [...new Set(shown.filter((r) => r.status === "pending" && r.approverId && r.approverId !== actor.id).map((r) => r.approverId as string))];
  const [balances, holidays, waits] = await Promise.all([
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
    medianDecisionHours(ctx.db, {
      companyId: actor.companyId,
      approverIds: waitingOn,
      since: new Date(now.getTime() - TYPICAL_WAIT_DAYS * 86_400_000),
      minSamples: TYPICAL_WAIT_MIN_DECISIONS,
    }),
  ]);
  const typicalWait = new Map(waits.map((w) => [w.approverId, w.hours]));
  return {
    /**
     * The person's latest {@link DASHBOARD_REQUESTS} requests (latest dates first), each
     * with whether it can be cancelled today ({@link canCancelOn}).
     */
    requests: shown.map((r) => ({
      ...r,
      cancellable: canCancelOn(r, today),
      /**
       * For a pending request with someone else: how long its approver usually takes, in
       * hours (their median over {@link TYPICAL_WAIT_DAYS} days), or `null` with too
       * little history to say.
       */
      typicalWaitHours: r.status === "pending" && r.approverId ? (typicalWait.get(r.approverId) ?? null) : null,
    })),
    /** `required` or `heads_up` (approval turned off): how the request form words itself. */
    approvalMode: readApprovalMode(settings.approvalMode),
    /** Whether the person has more requests than the dashboard shows. */
    moreRequests: requests.length > DASHBOARD_REQUESTS,
    /**
     * The form's default start date: the first working day from today (in the
     * company's time zone), so the pre-filled request is never worth zero days.
     */
    defaultDate: nextWorkingDay(today, { workingDays: settings.workingDays, holidays }),
    /** Active leave types in display order; the first is the form's default. */
    leaveTypes: types.filter((t) => !t.archived).map(({ id, name, code, color }) => ({ id, name, code, color })),
    /**
     * The person's balances, without types they have no days of at all (nothing
     * allotted and nothing booked), so "0 left of 0" never shows. Admin views keep them.
     */
    balances: balances && { ...balances, items: balances.items.filter((i) => !isEmptyBalance(i.balance)) },
    /**
     * From November 1 (company time zone): days of the main leave type (the first active
     * one, the form's default, usually vacation) that will not carry into next year, so
     * Home can say so once. Only that type: nobody should be told to use up sick days.
     * Empty before November, and when nothing is left to lose.
     */
    expiring:
      balances && today >= `${balances.year}-${EXPIRY_NUDGE_FROM}`
        ? balances.items.flatMap((item) => {
            const type = types.find((t) => t.id === item.leaveTypeId);
            const main = types.find((t) => !t.archived);
            if (!type || type.id !== main?.id || !item.balance.tracked || item.balance.remaining <= 0) return [];
            const carried = resolveAllowancePolicy(settings.allowancePolicy).carryover(type, item.balance) ?? 0;
            const days = addDays(item.balance.remaining, -Math.min(carried, item.balance.remaining));
            return days > 0 ? [{ leaveTypeId: item.leaveTypeId, name: item.name, days }] : [];
          })
        : [],
  };
}

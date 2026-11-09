import type { Transaction } from "@/db/types";
import { type Actor, isAdmin } from "@/domain/actor";
import { ManagerApprovalRule, reassignApprover } from "@/domain/approval-rule";
import { isCalendarDate } from "@/domain/calendar-date";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { canDecide, decidesByAssignment } from "@/domain/leave-permissions";
import { normalizeNote } from "@/domain/leave-request";
import { isCursorInstant, type PageCursor, readPage } from "@/domain/paging";
import { assertTransition } from "@/domain/request-status";
import type { ServiceContext } from "@/server/context";
import {
  countInbox,
  lockLeaveRequest,
  type InboxScope,
  type LeaveRequestRow,
  listInbox,
  listRecentDecisions,
  updateStatusIfCurrent,
} from "@/server/repositories/leave-requests";
import { findCompanySettings } from "@/server/repositories/calendar";
import { findLeaveType } from "@/server/repositories/leave-types";
import { findMember, listActiveAdmins } from "@/server/repositories/users";
import { alsoOffFor } from "./also-off";
import { activeContacts, recordLeaveChange, summarize } from "./leave-changes";
import { commitThenNotify } from "./notify";

export type Decision = "approve" | "reject";

export interface DecideInput {
  requestId: string;
  decision: Decision;
  /** Optional reason, stored as `decision_note` and included in the requester's email. */
  reason?: string | null;
  /**
   * Decide only while the request is assigned to this person, checked in the same
   * transaction: an email's Approve link speaks for the approver it was sent to and
   * nobody else, admins included. Must be the actor.
   */
  assignedTo?: string;
}

/** Requests per page of the inbox: each comes with its own decision form. */
export const INBOX_PAGE_SIZE = 10;

/** An inbox page's key: `[start_date, created_at, id]`. */
const INBOX_KEY = [isCalendarDate, isCursorInstant, isUuid] as const;

/** How far back Settled reaches. */
const SETTLED_DAYS = 30;

/** A Settled page's key: the audit row's `[created_at, id]`. */
const SETTLED_KEY = [isCursorInstant, isUuid] as const;

function scopeFor(actor: Actor): InboxScope {
  return { companyId: actor.companyId, deciderId: actor.id, isAdmin: isAdmin(actor) };
}

/**
 * Who the approval rule (minus self-approval) picks for `requesterId`'s pending
 * requests now, read inside `tx`: three reads at most. Also who is told when someone
 * cancels heads-up time off.
 */
export async function currentApprover(tx: Transaction, companyId: string, requesterId: string): Promise<string | null> {
  const [requester, admins] = await Promise.all([findMember(tx, companyId, requesterId), listActiveAdmins(tx, companyId)]);
  if (!requester) return null;
  const manager =
    requester.managerId && requester.managerId !== requester.id ? ((await findMember(tx, companyId, requester.managerId)) ?? null) : null;
  return reassignApprover(new ManagerApprovalRule(), { requester, manager, admins });
}

/**
 * Approves or rejects a pending request.
 *
 * The status change is a compare-and-set on `pending`, so when two people decide the
 * same request at once exactly one succeeds and the other gets `conflict`. A decision
 * that rests on the stored assignment ({@link decidesByAssignment}: a non-admin
 * approver, or an admin's own request routed to themself) first checks that the
 * approval rule still picks the actor, and its compare-and-set also requires the
 * request to still be assigned to them, so it loses to a concurrent reassignment.
 *
 * @throws DomainError `invalid_input` (reason too long), `not_found`, `forbidden`
 *   (neither an admin nor an assigned approver the rule still picks, or deciding one's
 *   own request), `invalid_transition` (no longer pending), or `conflict`.
 */
export async function decideLeaveRequest(ctx: ServiceContext, actor: Actor, input: DecideInput): Promise<LeaveRequestRow> {
  const reason = normalizeNote(input.reason, "reason");
  if (!isUuid(input.requestId)) throw new DomainError("not_found");
  if (input.decision !== "approve" && input.decision !== "reject") throw new DomainError("invalid_input");
  const to = input.decision === "approve" ? "approved" : "rejected";

  return commitThenNotify(ctx, actor.companyId, async (tx) => {
    const before = await lockLeaveRequest(tx, actor.companyId, input.requestId);
    if (!before) throw new DomainError("not_found");
    const byAssignment = decidesByAssignment(actor, before);
    const current = byAssignment && before.approverId === actor.id ? await currentApprover(tx, actor.companyId, before.userId) : null;
    if (!canDecide(actor, before, current)) throw new DomainError("forbidden");
    if (input.assignedTo !== undefined && (input.assignedTo !== actor.id || before.approverId !== actor.id))
      throw new DomainError("forbidden");
    assertTransition(before.status, to);

    const after = await updateStatusIfCurrent(
      tx,
      {
        companyId: actor.companyId,
        id: before.id,
        from: "pending",
        approverId: byAssignment || input.assignedTo !== undefined ? actor.id : undefined,
      },
      { status: to, decidedAt: ctx.now(), decisionNote: reason },
    );
    if (!after) throw new DomainError("conflict");
    await recordLeaveChange(tx, { event: to, before, after, source: actor.source });

    const contacts = await activeContacts(tx, actor.companyId, [after.userId]);
    const requester = contacts.get(after.userId);
    if (!requester) return { result: after, notify: [] };
    const leaveType = await findLeaveType(tx, actor.companyId, after.leaveTypeId);
    const leave = summarize(after, requester, leaveType?.name ?? "Time off");
    const data = { requestId: after.id, recipientName: requester.name, leave, reason, link: `${ctx.appUrl}/` };
    const type = to === "approved" ? "leave.approved" : "leave.rejected";
    return { result: after, notify: [{ type, to: requester.email, data }] };
  });
}

/** Which tab of the Approvals page: whose move it is. */
export type ApprovalsView = "mine" | "others" | "settled";

/**
 * The Approvals page, sorted by whose move it is, one tab at a time:
 *
 * - `mine` (Needs you): pending requests assigned to the actor, plus (for admins) any with
 *   no approver, since only an admin can decide those.
 * - `others` (Waiting on others): pending requests an admin may decide but that are
 *   assigned to someone else. Never anything for a non-admin.
 * - `settled`: requests the actor approved or declined in the last {@link SETTLED_DAYS}
 *   days, newest first (read from the audit log, so an
 *   admin's override counts as theirs; self-approvals are left out).
 *
 * Every tab is paged ({@link INBOX_PAGE_SIZE} a page; the pending ones earliest dates first);
 * deciding a request takes it off its tab, so the same page shows the next ones in its
 * place. Each pending request carries `alsoOff`, who else is off on its dates
 * ({@link alsoOffFor}). Both pending tabs are counted every time, for their labels (and
 * to hide Waiting when it is empty).
 *
 * @param page From a previous page's `previous` or `next`; the first page when absent.
 */
export async function getApprovalTriage(
  ctx: ServiceContext,
  actor: Actor,
  { view = "mine", page, size = INBOX_PAGE_SIZE }: { view?: ApprovalsView; page?: PageCursor; size?: number } = {},
) {
  const scope = scopeFor(actor);
  const tab: ApprovalsView = view === "others" && !scope.isAdmin ? "mine" : view;
  const [needsYouTotal, waitingTotal, settings] = await Promise.all([
    countInbox(ctx.db, { ...scope, part: "mine" }),
    scope.isAdmin ? countInbox(ctx.db, { ...scope, part: "others" }) : Promise.resolve(0),
    findCompanySettings(ctx.db, actor.companyId),
  ]);
  const base = { view: tab, needsYouTotal, waitingTotal, settledDays: SETTLED_DAYS, timeZone: settings?.timezone ?? "UTC" };

  if (tab === "settled") {
    const since = new Date(ctx.now().getTime() - SETTLED_DAYS * 86_400_000);
    const decisions = await readPage({
      cursor: page,
      size,
      checks: SETTLED_KEY,
      read: (request, limit) => listRecentDecisions(ctx.db, { companyId: actor.companyId, deciderId: actor.id, since }, limit, request),
      keyOf: (d) => [d.cursor, d.auditId],
    });
    const settled = decisions.items.map((d) => ({
      ...d,
      decision: d.action === "leave_request.approved" ? ("approved" as const) : ("rejected" as const),
    }));
    return { ...base, items: [], previous: decisions.previous, next: decisions.next, settled };
  }

  const inbox = await readPage({
    cursor: page,
    size,
    checks: INBOX_KEY,
    read: (request, limit) => listInbox(ctx.db, { ...scope, part: tab }, limit, request),
    keyOf: (r) => [r.startDate, r.cursor, r.id],
  });
  const alsoOff = await alsoOffFor(
    ctx.db,
    actor.companyId,
    inbox.items.map((r) => ({
      id: r.id,
      userId: r.requesterId,
      departmentId: r.requesterDepartmentId,
      departmentName: r.requesterDepartmentName,
      startDate: r.startDate,
      endDate: r.endDate,
    })),
  );
  const items = inbox.items.map((r) => ({ ...r, alsoOff: alsoOff.get(r.id) ?? null }));
  return { ...base, items, previous: inbox.previous, next: inbox.next, settled: [] };
}

/**
 * Whether the header shows the Approvals link, and how many requests wait there.
 * Managers and admins always see it; anyone else only while something is assigned
 * to them.
 */
export async function getApprovalNav(ctx: ServiceContext, actor: Actor): Promise<{ visible: boolean; pending: number }> {
  const pending = await countInbox(ctx.db, scopeFor(actor));
  return { visible: actor.role !== "employee" || pending > 0, pending };
}

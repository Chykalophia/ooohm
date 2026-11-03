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
  findLeaveRequest,
  type InboxScope,
  type LeaveRequestRow,
  listInbox,
  updateStatusIfCurrent,
} from "@/server/repositories/leave-requests";
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
}

/** Requests per page of the inbox: each comes with its own decision form. */
export const INBOX_PAGE_SIZE = 10;

/** An inbox page's key: `[start_date, created_at, id]`. */
const INBOX_KEY = [isCalendarDate, isCursorInstant, isUuid] as const;

function scopeFor(actor: Actor): InboxScope {
  return { companyId: actor.companyId, deciderId: actor.id, isAdmin: isAdmin(actor) };
}

/**
 * Who the approval rule (minus self-approval) picks for `requesterId`'s pending
 * requests now, read inside `tx`: three reads at most.
 */
async function currentApprover(tx: Transaction, companyId: string, requesterId: string): Promise<string | null> {
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
  const reason = normalizeNote(input.reason);
  if (!isUuid(input.requestId)) throw new DomainError("not_found");
  if (input.decision !== "approve" && input.decision !== "reject") throw new DomainError("invalid_input");
  const to = input.decision === "approve" ? "approved" : "rejected";

  return commitThenNotify(ctx, async (tx) => {
    const before = await findLeaveRequest(tx, actor.companyId, input.requestId);
    if (!before) throw new DomainError("not_found");
    const byAssignment = decidesByAssignment(actor, before);
    const current = byAssignment && before.approverId === actor.id ? await currentApprover(tx, actor.companyId, before.userId) : null;
    if (!canDecide(actor, before, current)) throw new DomainError("forbidden");
    assertTransition(before.status, to);

    const after = await updateStatusIfCurrent(
      tx,
      { companyId: actor.companyId, id: before.id, from: "pending", approverId: byAssignment ? actor.id : undefined },
      { status: to, decidedAt: ctx.now(), decisionNote: reason },
    );
    if (!after) throw new DomainError("conflict");
    await recordLeaveChange(tx, { event: to, before, after, source: actor.source });

    const contacts = await activeContacts(tx, actor.companyId, [after.userId]);
    const requester = contacts.get(after.userId);
    if (!requester) return { result: after, outgoing: [] };
    const leaveType = await findLeaveType(tx, actor.companyId, after.leaveTypeId);
    const leave = summarize(after, requester, leaveType?.name ?? "Time off");
    const link = `${ctx.appUrl}/`;
    const email = { kind: to, recipientName: requester.name, leave, reason, link } as const;
    return { result: after, outgoing: [{ to: requester.email, email }] };
  });
}

/**
 * One page of the pending requests the actor can decide: those assigned to them and, for
 * admins, every other pending request in the company. Earliest start date first.
 *
 * Deciding a request takes it off the list, so the same page shows the next ones in its
 * place.
 *
 * @param page From a previous page's `previous` or `next`; the first page when absent.
 * @returns The page's `items`, each with `alsoOff`, who else is off on its dates
 *   (`alsoOffFor`); the cursors either side; and the `total` waiting, which is counted
 *   only when there is more than one page.
 */
export async function listApprovalInbox(ctx: ServiceContext, actor: Actor, { page, size = INBOX_PAGE_SIZE }: { page?: PageCursor; size?: number } = {}) {
  const scope = scopeFor(actor);
  const inbox = await readPage({
    cursor: page,
    size,
    checks: INBOX_KEY,
    read: (request, limit) => listInbox(ctx.db, scope, limit, request),
    keyOf: (r) => [r.startDate, r.cursor, r.id],
  });
  const rows = inbox.items;
  const [total, alsoOff] = await Promise.all([
    inbox.previous || inbox.next ? countInbox(ctx.db, scope) : rows.length,
    alsoOffFor(ctx.db, actor.companyId, rows.map((r) => ({ id: r.id, userId: r.requesterId, startDate: r.startDate, endDate: r.endDate }))),
  ]);
  return { items: rows.map((r) => ({ ...r, alsoOff: alsoOff.get(r.id) ?? null })), previous: inbox.previous, next: inbox.next, total };
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

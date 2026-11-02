import type { Transaction } from "@/db/types";
import { type Actor, isAdmin } from "@/domain/actor";
import { ManagerApprovalRule, reassignApprover } from "@/domain/approval-rule";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { canDecide, decidesByAssignment } from "@/domain/leave-permissions";
import { normalizeNote } from "@/domain/leave-request";
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
import { activeContacts, recordLeaveChange, summarize } from "./leave-changes";
import { commitThenNotify } from "./notify";

export type Decision = "approve" | "reject";

export interface DecideInput {
  requestId: string;
  decision: Decision;
  /** Optional reason, stored as `decision_note` and included in the requester's email. */
  reason?: string | null;
}

/** Most pending requests the inbox shows at once. */
const INBOX_LIMIT = 100;

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
 * Pending requests the actor can decide: those assigned to them and, for admins,
 * every other pending request in the company. Earliest start date first.
 *
 * @param limit Most items to return; defaults to {@link INBOX_LIMIT}.
 * @returns At most `limit` `items`, and the `total` waiting, which is larger than
 *   `items.length` only when the list was cut. The count query runs only in that case.
 */
export async function listApprovalInbox(ctx: ServiceContext, actor: Actor, limit = INBOX_LIMIT) {
  const scope = scopeFor(actor);
  const items = await listInbox(ctx.db, scope, limit);
  const total = items.length < limit ? items.length : await countInbox(ctx.db, scope);
  return { items, total };
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

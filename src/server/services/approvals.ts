import { type Actor, isAdmin } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { canDecide } from "@/domain/leave-permissions";
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
 * Approves or rejects a pending request.
 *
 * The status change is a compare-and-set on `pending`, so when two people decide the
 * same request at once exactly one succeeds and the other gets `conflict`.
 *
 * @throws DomainError `invalid_input` (reason too long), `not_found`, `forbidden`
 *   (neither the assigned approver nor an admin, or deciding one's own request),
 *   `invalid_transition` (no longer pending), or `conflict`.
 */
export async function decideLeaveRequest(ctx: ServiceContext, actor: Actor, input: DecideInput): Promise<LeaveRequestRow> {
  const reason = normalizeNote(input.reason);
  if (!isUuid(input.requestId)) throw new DomainError("not_found");
  if (input.decision !== "approve" && input.decision !== "reject") throw new DomainError("invalid_input");
  const to = input.decision === "approve" ? "approved" : "rejected";

  return commitThenNotify(ctx, async (tx) => {
    const before = await findLeaveRequest(tx, actor.companyId, input.requestId);
    if (!before) throw new DomainError("not_found");
    if (!canDecide(actor, before)) throw new DomainError("forbidden");
    assertTransition(before.status, to);

    const after = await updateStatusIfCurrent(
      tx,
      { companyId: actor.companyId, id: before.id, from: "pending" },
      { status: to, decidedAt: ctx.now(), decisionNote: reason },
    );
    if (!after) throw new DomainError("conflict");
    await recordLeaveChange(tx, { event: to, before, after, actorId: actor.id });

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

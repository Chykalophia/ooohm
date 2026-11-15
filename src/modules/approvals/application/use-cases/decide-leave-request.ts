import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { isUuid } from "@/shared/kernel/uuid";
import {
  assertTransition,
  canDecide,
  decidesByAssignment,
  type LeaveRequest,
  type LeaveRequestDTO,
  normalizeNote,
  summarize,
  toLeaveRequestDTO,
} from "@/modules/leave";
import type { Notification } from "@/modules/notifications";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import type { ApprovalDeps, ApprovalStore } from "../ports";
import { currentApprover } from "../routing";

export type Decision = "approve" | "reject";

export interface DecideInput {
  requestId: string;
  decision: Decision;
  /** Optional reason, stored as `decision_note` and included in the requester's email. */
  reason?: string | null | undefined;
  /**
   * Decide only while the request is assigned to this person, checked in the same
   * transaction: an email's Approve link speaks for the approver it was sent to and
   * nobody else, admins included. Must be the actor.
   */
  assignedTo?: string | undefined;
}

/**
 * Approves or rejects a pending request. A reason is optional either way.
 *
 * The status change is a compare-and-set on `pending`, so when two people decide the
 * same request at once exactly one succeeds and the other gets `conflict`. A decision
 * that rests on the stored assignment (`decidesByAssignment`: a non-admin approver, or
 * an admin's own request routed to themself) first checks that the approval rule still
 * picks the actor, and its compare-and-set also requires the request to still be
 * assigned to them, so it loses to a concurrent reassignment.
 *
 * Fails with `invalid_input` (reason too long, unknown decision), `not_found`,
 * `forbidden` (neither an admin nor an assigned approver the rule still picks, deciding
 * one's own request, or not the `assignedTo` approver), `invalid_transition` (no longer
 * pending), or `conflict`.
 */
export async function decideLeaveRequest(deps: ApprovalDeps, actor: Actor, input: DecideInput): Promise<ServiceResult<LeaveRequestDTO>> {
  return attempt(async () => {
    const reason = normalizeNote(input.reason, "reason");
    if (!isUuid(input.requestId)) throw new DomainError("not_found");
    if (input.decision !== "approve" && input.decision !== "reject") throw new DomainError("invalid_input");
    const to = input.decision === "approve" ? "approved" : "rejected";

    return deps.unitOfWork(actor.companyId, async (store) => {
      const before = await store.requests.lock(actor.companyId, input.requestId);
      if (!before) throw new DomainError("not_found");
      const byAssignment = await assertMayDecide(store, actor, before, input.assignedTo);
      assertTransition(before.status, to);

      const after = await store.requests.decideIfCurrent(
        { companyId: actor.companyId, id: before.id, from: "pending", approverId: byAssignment || input.assignedTo !== undefined ? actor.id : undefined },
        { status: to, decidedAt: deps.now(), decisionNote: reason },
      );
      if (!after) throw new DomainError("conflict");
      await store.changes.decision({ event: to, before, after, source: actor.source });
      return { result: toLeaveRequestDTO(after), notify: await decisionMail(deps, store, after, reason) };
    });
  });
}

/** Throws `forbidden` unless the actor may decide `before` now; whether the decision rests on the assignment. */
async function assertMayDecide(store: ApprovalStore, actor: Actor, before: LeaveRequest, assignedTo: string | undefined): Promise<boolean> {
  const byAssignment = decidesByAssignment(actor, before);
  const current = byAssignment && before.approverId === actor.id ? await currentApprover(store.contexts, actor.companyId, before.userId) : null;
  if (!canDecide(actor, before, current)) throw new DomainError("forbidden");
  if (assignedTo !== undefined && (assignedTo !== actor.id || before.approverId !== actor.id)) throw new DomainError("forbidden");
  return byAssignment;
}

/** `leave.approved` or `leave.rejected` to the requester, unless they are no longer active. */
async function decisionMail(deps: ApprovalDeps, store: ApprovalStore, after: LeaveRequest, reason: string | null): Promise<Notification[]> {
  const requester = (await store.directory.activeContacts(after.companyId, [after.userId])).get(after.userId);
  if (!requester) return [];
  const leaveTypeName = await store.directory.leaveTypeName(after.companyId, after.leaveTypeId);
  const leave = summarize(after, requester, leaveTypeName ?? "Time off");
  const data = { requestId: after.id, recipientName: requester.name, leave, reason, link: `${deps.appUrl}/` };
  const type = after.status === "approved" ? "leave.approved" : "leave.rejected";
  return [{ type, to: requester.email, data }];
}

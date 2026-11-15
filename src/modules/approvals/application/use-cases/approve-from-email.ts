import "server-only";
import type { Actor } from "@/domain/actor";
import { ok, type ServiceResult } from "@/shared/lib/result";
import type { EmailApproval } from "../dto";
import { resolveLink } from "../email-link";
import type { ApprovalDeps } from "../ports";
import { decideLeaveRequest } from "./decide-leave-request";

/**
 * Approves the request an approve link names, as the approver it was sent to, through
 * the link: the same {@link decideLeaveRequest} as the Approvals page, with every check
 * it makes plus `assignedTo`, and an audit row and event whose actor reads
 * `via: "email_link"`. Declining happens in the app, so it is never offered here.
 *
 * Every way the link can end is an {@link EmailApproval}; a failure is only what
 * nothing here expects (a decision failing for another reason).
 */
export async function approveFromEmail(deps: ApprovalDeps, token: string): Promise<ServiceResult<EmailApproval>> {
  const { approval, actor } = await resolveLink(deps, token);
  if (approval.state !== "ready" || !actor) return ok(approval);
  const decided = await decideLeaveRequest(deps, actor, { requestId: approval.request.id, decision: "approve", assignedTo: actor.id });
  if (decided.ok) return ok({ state: "approved", request: { ...approval.request, status: "approved" } });
  const { code } = decided.error;
  if (code === "forbidden") return ok({ state: "not_yours" });
  if (code === "invalid_transition" || code === "conflict") return ok(await afterLosing(deps, actor, approval.request.id));
  return decided;
}

/** What the link shows once someone else's change got there first. */
async function afterLosing(deps: ApprovalDeps, actor: Actor, requestId: string): Promise<EmailApproval> {
  const now = await deps.read.requests.findForReview(actor.companyId, requestId);
  if (!now) return { state: "invalid" };
  return now.approverId === actor.id ? { state: "decided", request: now } : { state: "not_yours" };
}

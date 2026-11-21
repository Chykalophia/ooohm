import "server-only";
import { type Actor, toActor } from "@/shared/kernel/actor";
import { byUser, CHANGE_PROCESSES } from "@/shared/kernel/change-source";
import { isUuid } from "@/shared/kernel/uuid";
import { verifyApproveToken } from "@/lib/email-link-token";
import type { EmailApproval } from "./dto";
import type { ApprovalDeps } from "./ports";

/** The approver the link names, acting through it, or `null` when they cannot act on its request at all. */
async function linkActor(deps: ApprovalDeps, approverId: string, requestId: string): Promise<Actor | null> {
  const person = await deps.read.directory.linkPerson(approverId, requestId);
  if (!person?.isActive) return null;
  const actor = toActor(person);
  return actor && { ...actor, source: byUser(actor.id, CHANGE_PROCESSES.emailLink) };
}

/**
 * Checks a link and reads its request: the {@link EmailApproval} to show, and the
 * approver acting through the link when there is one. The link speaks only for the
 * person it was sent to, and only while the request is still theirs: once it moves to
 * someone else the link shows nothing about it, decided or not. The approver's company is
 * found from the link's person and request (a pre-tenant read, which finds them only while
 * the request is assigned to them); `deps` comes back scoped to it.
 */
export async function resolveLink(deps: ApprovalDeps, token: string): Promise<{ approval: EmailApproval; actor?: Actor; deps?: ApprovalDeps }> {
  if (!deps.linkKey) return { approval: { state: "invalid" } };
  const check = verifyApproveToken(deps.linkKey, token, deps.now());
  if (!check.ok) return { approval: { state: check.reason } };
  const { requestId, approverId } = check.claims;
  if (!isUuid(requestId)) return { approval: { state: "invalid" } };
  const actor = await linkActor(deps, approverId, requestId);
  if (!actor) return { approval: { state: "not_yours" } };
  // From here on, everything reads and writes in the approver's company.
  const scoped = deps.tenant(actor.companyId);
  const request = await scoped.read.requests.findForReview(actor.companyId, requestId);
  if (!request) return { approval: { state: "invalid" } };
  if (request.approverId !== actor.id) return { approval: { state: "not_yours" } };
  if (request.status !== "pending") return { approval: { state: "decided", request } };
  // The full rule (the approval rule still picks them) runs on approve; this is the cheap part.
  return { approval: { state: "ready", request }, actor, deps: scoped };
}

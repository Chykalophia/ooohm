import "server-only";
import type { Actor } from "@/domain/actor";
import type { ApprovalNavDTO } from "../dto";
import type { ApprovalDeps } from "../ports";
import { inboxScopeFor } from "./get-approval-triage";

/**
 * Whether the header shows the Approvals link, and how many requests wait there.
 * Managers and admins always see it; anyone else only while something is assigned
 * to them.
 */
export async function getApprovalNav(deps: ApprovalDeps, actor: Actor): Promise<ApprovalNavDTO> {
  const pending = await deps.read.inbox.count(inboxScopeFor(actor));
  return { visible: actor.role !== "employee" || pending > 0, pending };
}

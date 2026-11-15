import "server-only";
/** Who decides, read through {@link ApprovalContextReader}: for a new request, and for one already pending. */
import type { ApprovalDecision, ApprovalMode } from "@/shared/kernel/approval";
import type { ApprovalContext } from "../domain/approval-context";
import { approvalRuleFor } from "../domain/approval-rule";
import { approverFor } from "../domain/approver-for";
import type { ApprovalContextReader, RoutingRequester } from "./ports";

async function contextOf(reader: ApprovalContextReader, companyId: string, requester: RoutingRequester): Promise<ApprovalContext> {
  return (await reader.contextsFor(companyId, [requester])).get(requester.id)!;
}

/**
 * Who decides `requester`'s new request under the company's approval `mode`: the rule
 * for that mode on what the reader loads now.
 * @throws DomainError `no_approver` when nobody can.
 */
export async function routeRequest(reader: ApprovalContextReader, companyId: string, requester: RoutingRequester, mode: ApprovalMode): Promise<ApprovalDecision> {
  return approvalRuleFor(mode).resolve(await contextOf(reader, companyId, requester));
}

/**
 * Who the approval rule (minus self-approval) picks for `requesterId`'s pending
 * requests now: five reads at most. Also who is told when someone cancels heads-up time off.
 */
export async function currentApprover(reader: ApprovalContextReader, companyId: string, requesterId: string): Promise<string | null> {
  const [requester] = await reader.requesters(companyId, [requesterId]);
  if (!requester) return null;
  return approverFor(await contextOf(reader, companyId, requester));
}

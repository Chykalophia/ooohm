import type { ApprovalMode } from "@/shared/kernel/approval";
import type { ApprovalContext, ApprovalDecision, ApprovalRule } from "./approval-context";
import { ManagerApprovalRule, reassignApprover } from "./approver-for";

/**
 * Heads-up time off: nothing waits for a decision. Every request is approved as it is
 * sent, recorded as decided by the requester (nobody else decided it), and the person
 * {@link ManagerApprovalRule} would have routed it to is told (`informId`): the
 * requester's active manager, else the longest-standing other active admin. With
 * nobody to tell (or only the requester themself), `informId` is `null` and the time
 * off is booked all the same: turning approval off never blocks anyone.
 */
export class HeadsUpApprovalRule implements ApprovalRule {
  constructor(private readonly routing: ApprovalRule = new ManagerApprovalRule()) {}

  resolve(context: ApprovalContext): ApprovalDecision {
    const told = reassignApprover(this.routing, context);
    return { kind: "auto_approve", approverId: context.requester.id, informId: told === context.requester.id ? null : told };
  }
}

/** The rule for a company's {@link ApprovalMode}. */
export function approvalRuleFor(mode: ApprovalMode): ApprovalRule {
  return mode === "heads_up" ? new HeadsUpApprovalRule() : new ManagerApprovalRule();
}

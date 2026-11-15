import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { unwrap } from "@/shared/lib/result";
import type { DateRange } from "../domain/date-range";
import type { DayCount } from "../domain/day-count";
import { type LeaveRequest, submitLeave } from "../domain/leave-request";
import { recordEvent } from "./leave-changes";
import type { LeaveDeps, LeaveStore } from "./ports";
import type { ApprovalDecision } from "@/shared/kernel/approval";
import type { LeaveAssessment } from "@/modules/balances";

/** What a new request costs and who decides it. */
export interface StoredPlan {
  assessment: LeaveAssessment;
  decision: ApprovalDecision;
}

/**
 * Stores the request (`pending`, with its per-year days) and, when the rule approves it
 * at once (`decision.kind` is `auto_approve`), approves it, recording each step: the
 * submit path of `submitLeaveRequest` and of adding leave for someone. Returns the
 * request in its final state; throws a `DomainError` to roll the unit of work back.
 */
export async function storeSubmission(
  deps: LeaveDeps,
  store: LeaveStore,
  actor: Pick<Actor, "companyId" | "source">,
  facts: { plan: StoredPlan; range: DateRange; note: string | null; userId: string },
): Promise<LeaveRequest> {
  const { assessment, decision } = facts.plan;
  const { userId } = facts;
  const submission = unwrap(
    submitLeave({
      draft: {
        id: deps.ids.next(),
        companyId: actor.companyId,
        userId,
        leaveTypeId: assessment.leaveType.id,
        range: assessment.range,
        days: assessment.days as DayCount,
        note: facts.note,
        approverId: decision.approverId,
      },
      active: await store.requests.findActiveOverlapping(userId, facts.range),
      autoApprove: decision.kind === "auto_approve",
      now: deps.clock.now(),
    }),
  );
  const created = await store.requests.insert(submission.requested);
  await store.requests.saveYearDays(created.id, assessment.charges);
  const [requested, approval] = submission.events;
  await recordEvent(store.changes, requested, { before: null, after: created }, actor.source);
  if (!submission.approved || !approval) return created;
  const approved = await store.requests.updateStatusIfCurrent(
    { companyId: actor.companyId, id: created.id, from: "pending" },
    { status: "approved", decidedAt: submission.approved.decidedAt ?? deps.clock.now() },
  );
  if (!approved) throw new DomainError("conflict");
  await recordEvent(store.changes, approval, { before: created, after: approved }, actor.source);
  return approved;
}

import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { remainingAfter, type RequestCost } from "../../domain/allowance-policy";
import type { LeaveDraft } from "../dto";
import type { BalancesDeps } from "../ports";
import { assessLeaveRequest } from "./assess-leave-request";

/**
 * What a draft request would cost and leave, for the live preview. Runs exactly the
 * checks submit runs ({@link assessLeaveRequest}), without writing anything, and fails
 * with the code submit would (the preview shows its message).
 */
export function previewLeaveRequest(deps: BalancesDeps, actor: Actor, draft: LeaveDraft): Promise<ServiceResult<RequestCost>> {
  return attempt(async () => {
    const assessment = await assessLeaveRequest(deps.read, actor, draft);
    return {
      days: assessment.days,
      years: assessment.charges.map(({ year, days, before }) => ({ year, days, remainingAfter: remainingAfter(before, days) })),
    };
  });
}

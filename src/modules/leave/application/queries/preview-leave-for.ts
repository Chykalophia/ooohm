import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { type LeaveDraft, remainingAfter, type RequestCost } from "@/modules/balances";
import { isUuid } from "@/shared/kernel/uuid";
import { personLabel } from "@/shared/kernel/person-label";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { assessFor, checkAddFor } from "../leave-for";
import type { LeaveDeps } from "../ports";

/**
 * What adding this time off for `userId` would cost, for the live preview on their team
 * page. Runs the checks `addLeaveFor` runs, without writing anything. What they would
 * have left is shown only to someone who may see their balance. `personName` is how the
 * preview names them.
 *
 * Fails as `addLeaveFor`, minus `rate_limited`.
 */
export async function previewLeaveFor(
  deps: LeaveDeps,
  actor: Actor,
  userId: string,
  draft: LeaveDraft,
): Promise<ServiceResult<{ cost: RequestCost; personName: string }>> {
  if (!isUuid(userId)) return err("not_found");
  return attempt(async () => {
    const store = deps.read;
    const { person, seesBalance } = await checkAddFor(store.directory, actor, await store.directory.findPerson(actor.companyId, userId));
    const assessment = await assessFor(store, actor, person, draft, seesBalance);
    const years = assessment.charges.map(({ year, days, before }) => ({ year, days, remainingAfter: seesBalance ? remainingAfter(before, days) : null }));
    return { cost: { days: assessment.days, years }, personName: personLabel(person) };
  });
}

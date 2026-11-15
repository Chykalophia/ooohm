import "server-only";
import type { Actor } from "@/domain/actor";
import { yearInTimeZone } from "@/lib/dates";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import type { BalanceSummary } from "../dto";
import type { BalancesDeps } from "../ports";
import { summarizeBalances } from "./summarize-balances";

/**
 * The actor's balance for every active leave type in one year (plus archived types
 * they have history with, see {@link summarizeBalances}): by default the current year
 * in the company's time zone.
 *
 * Four reads whatever the number of types or requests: company settings and leave
 * types, then allowance rows and booked-day sums, each pair in parallel. Fails with
 * `no_company`, or `policy_unavailable` when the company's policy is unknown.
 */
export async function getBalanceSummary(deps: BalancesDeps, actor: Actor, year?: number): Promise<ServiceResult<BalanceSummary>> {
  const { directory } = deps.read;
  const [company, types] = await Promise.all([directory.company(actor.companyId), directory.leaveTypesWithAllowance(actor.companyId)]);
  if (!company) return err("no_company");
  return attempt(() =>
    summarizeBalances(deps.read, actor, {
      allowancePolicy: company.allowancePolicy,
      types,
      year: year ?? yearInTimeZone(company.timezone, deps.clock.now()),
    }),
  );
}

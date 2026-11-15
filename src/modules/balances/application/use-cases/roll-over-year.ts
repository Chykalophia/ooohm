import "server-only";
import { bySystem, CHANGE_PROCESSES } from "@/domain/change-source";
import { DomainError } from "@/domain/errors";
import { yearInTimeZone } from "@/lib/dates";
import { log } from "@/lib/log";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import type { AllowancePolicy } from "../../domain/allowance-policy";
import { resolveAllowancePolicy } from "../../domain/policy-registry";
import { type RollCounts, rollMember } from "../member-rollover";
import type { BalancesCompany, BalancesDeps } from "../ports";

/** What one run changed. A second run over the same data reports zeros. */
export interface RolloverResult extends RollCounts {
  companies: number;
  /** Active members processed. */
  members: number;
}

/** The nightly (or `pnpm job:rollover`) run has no person behind it. */
const ROLLOVER_SOURCE = bySystem(CHANGE_PROCESSES.yearRollover);

interface CompanyPlan {
  company: BalancesCompany;
  policy: AllowancePolicy;
  currentYear: number;
  closingYear: number;
}

/**
 * Closes a calendar year: carries leave over into the next year and makes sure every
 * active member has an allowance row for the current year. Idempotent: it sets values
 * rather than adding to them, so running it again over the same data changes nothing
 * and writes nothing.
 *
 * For every company, every active member and every active leave type that counts
 * against allowance with `carryover_enabled`, next year's `carried_over_days` becomes
 * the policy's carryover of the closing year's remaining before any carry (v1:
 * clamped to `[0, carryover_max_days]`). A missing next-year row is created from the
 * type's default allowance. Members created after the closing year carry nothing.
 * For every counting type without a default, carryover on or off, a person with a row
 * in or before the closing year gets a missing next-year row copied from their latest
 * one (`days`), even when nothing carries; the balance already inherits that row, so
 * this only makes it explicit. Then each member gets a current-year row, from their
 * default (the allowance rule for their department and level, else the type's), for
 * every tracked type that has one; existing rows are never overwritten.
 *
 * Each member is processed in its own unit of work under their member lock, and every
 * row created or changed writes an `audit_log` row (`allowance.carried_over` or
 * `allowance.created`, source `system` / `year_rollover`) and a `balance.adjusted`
 * event in it. Carryover stays off unless a leave type turns it on.
 *
 * Re-running after a closing-year request is cancelled, rejected or added recomputes
 * the carryover from the new remaining, and records the change. So this job owns
 * `carried_over_days`: a hand edit there is overwritten by the next run, and balance
 * corrections belong in `adjustment_days`, which it never touches.
 *
 * @param fromYear The year to close. Defaults to the year before the current one in
 *   each company's time zone. Fails, before any change, with `policy_unavailable` when
 *   a company's policy is unknown, or `invalid_input` when `fromYear` has not ended yet
 *   for a company.
 */
export function runYearRollover(deps: BalancesDeps, fromYear?: number): Promise<ServiceResult<RolloverResult>> {
  return attempt(async () => {
    const plans = (await deps.read.directory.companies()).map((company) => planCompany(company, deps.clock.now(), fromYear));
    const result: RolloverResult = { companies: plans.length, members: 0, carried: 0, created: 0 };
    for (const plan of plans) {
      const { members, carried, created } = await rollCompany(deps, plan);
      result.members += members;
      result.carried += carried;
      result.created += created;
    }
    return result;
  });
}

/** The policy and years one company's run uses. @throws DomainError as {@link runYearRollover} fails. */
function planCompany(company: BalancesCompany, now: Date, fromYear: number | undefined): CompanyPlan {
  const policy = resolveAllowancePolicy(company.allowancePolicy);
  const currentYear = yearInTimeZone(company.timezone, now);
  const closingYear = fromYear ?? currentYear - 1;
  if (!Number.isInteger(closingYear) || closingYear >= currentYear) {
    throw new DomainError("invalid_input", `Year ${closingYear} has not ended yet (it is ${currentYear} in ${company.timezone}).`);
  }
  return { company, policy, currentYear, closingYear };
}

/** Rolls every active member of one company over, each in their own unit of work. */
async function rollCompany(deps: BalancesDeps, { company, policy, currentYear, closingYear }: CompanyPlan): Promise<RollCounts & { members: number }> {
  const { directory } = deps.read;
  const [types, members] = await Promise.all([directory.activeLeaveTypes(company.id), directory.activeMembers(company.id)]);
  const counting = types.filter((t) => t.countsAgainstAllowance);
  let carried = 0;
  let created = 0;
  for (const member of members) {
    const changes = await deps.unitOfWork((store) =>
      rollMember(store, {
        companyId: company.id,
        timezone: company.timezone,
        policy,
        memberId: member.id,
        memberCreatedAt: member.createdAt,
        types: counting,
        createDefaults: true,
        closingYear,
        currentYear,
        source: ROLLOVER_SOURCE,
      }),
    );
    carried += changes.carried;
    created += changes.created;
  }
  log.info({ companyId: company.id, closingYear, members: members.length, carried, created }, "year_rollover_company");
  return { members: members.length, carried, created };
}

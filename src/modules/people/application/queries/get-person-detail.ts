import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError, isDomainError } from "@/shared/kernel/errors";
import { firstEditableAllowanceYear } from "@/shared/kernel/leave-type-settings";
import { yearInTimeZone } from "@/lib/dates";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { type AllowanceDefaults, type BalanceSummary, loadAllowanceDefaults, summarizeBalances } from "@/modules/balances";
import { findCompany } from "@/modules/organisation";
import { type PersonDTO, toPersonDTO } from "@/modules/people/application/dto";
import { canManagePeople } from "@/modules/people/application/policies";
import { listLeaveTypesWithAllowance } from "@/shared/lib/db/leave-type-allowances";
import { findPerson } from "@/shared/lib/db/members";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

export interface PersonDetailDTO {
  person: PersonDTO;
  timezone: string;
  year: number;
  /** Allowances of years before this one are closed; see `firstEditableAllowanceYear`. */
  firstEditableYear: number;
  /** `null` when the company's allowance policy is unknown. */
  balances: BalanceSummary | null;
  /** Each type's allowance settings, by id, for the allowance editor: the default is this person's (allowance rules applied). */
  leaveTypes: Map<string, { countsAgainstAllowance: boolean; defaultAllowanceDays: number | null }>;
}

/**
 * One person as their admin page shows them, with their balance per active leave type
 * (plus archived types they have an allowance or booked days for) for `year` (default:
 * the current year in the company's time zone), computed by the same balance code as
 * their dashboard.
 *
 * Fails with `forbidden` for a non-admin, `not_found` for someone outside the actor's
 * company, or `no_company`.
 */
export async function getPersonDetail(ctx: ServiceContext, actor: Actor, userId: string, year?: number): Promise<ServiceResult<PersonDetailDTO>> {
  if (!canManagePeople(actor)) return err("forbidden");
  return attempt(async () => {
    const [person, company, types] = await Promise.all([
      findPerson(ctx.db, actor.companyId, userId),
      findCompany(ctx.db, actor.companyId),
      listLeaveTypesWithAllowance(ctx.db, actor.companyId),
    ]);
    if (!person) throw new DomainError("not_found");
    if (!company) throw new DomainError("no_company");
    const balanceYear = year ?? yearInTimeZone(company.timezone, ctx.now());
    const defaults = await loadAllowanceDefaults(ctx.db, actor.companyId, [person.id]);
    const balances = await balancesOf(ctx, actor, person.id, { allowancePolicy: company.allowancePolicy, types, year: balanceYear, defaults });
    return {
      person: toPersonDTO(person),
      timezone: company.timezone,
      year: balanceYear,
      firstEditableYear: firstEditableAllowanceYear(yearInTimeZone(company.timezone, ctx.now())),
      balances,
      leaveTypes: new Map(
        types.map((t) => [t.id, { countsAgainstAllowance: t.countsAgainstAllowance, defaultAllowanceDays: defaults(person.id, t) }]),
      ),
    };
  });
}

type BalanceInputs = { allowancePolicy: string; types: Awaited<ReturnType<typeof listLeaveTypesWithAllowance>>; year: number; defaults: AllowanceDefaults };

/** The person's balances, or `null` (logged) when the company's allowance policy is unknown. */
async function balancesOf(ctx: ServiceContext, actor: Actor, userId: string, loaded: BalanceInputs): Promise<BalanceSummary | null> {
  return summarizeBalances(ctx.db, { id: userId, companyId: actor.companyId }, loaded).catch((e: unknown) => {
    if (!isDomainError(e, "policy_unavailable")) throw e;
    log.error({ err: e, companyId: actor.companyId }, "allowance_policy_unavailable");
    return null;
  });
}

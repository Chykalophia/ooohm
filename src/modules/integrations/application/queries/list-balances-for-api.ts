import "server-only";
import { resolveAllowancePolicy } from "@/domain/allowance-policy";
import { DomainError } from "@/domain/errors";
import { yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { listAllowances, sumBookedDays } from "@/server/repositories/balances";
import { findCompanySettings } from "@/server/repositories/calendar";
import { listLeaveTypesWithAllowance } from "@/server/repositories/leave-type-allowances";
import { allowanceYearsFor, balanceInputs, loadAllowanceDefaults } from "@/server/services/balances";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { type ApiClient, assertScope } from "@/modules/integrations/domain/integrations";
import { listBalanceSubjects } from "@/modules/integrations/infrastructure/drizzle-api-reads.repository";

export interface ApiBalance {
  userId: string;
  leaveTypeId: string;
  year: number;
  /** False for an unlimited type: only `used` and `pending` apply, the rest are `null`. */
  tracked: boolean;
  allowance: number | null;
  carriedOver: number | null;
  adjustment: number | null;
  total: number | null;
  used: number;
  pending: number;
  carriedOut: number | null;
  remaining: number | null;
}

type Inputs = ReturnType<typeof balanceInputs>;
type Policy = ReturnType<typeof resolveAllowancePolicy>;
type LeaveTypeWithAllowance = Awaited<ReturnType<typeof listLeaveTypesWithAllowance>>[number];

/**
 * One person's balance of one type as the API publishes it, field by field: a field a
 * future policy adds to the domain Balance must not leak into the versioned public
 * payload unannounced. An archived type is listed only where the person has an
 * allowance row or booked days for it.
 */
function apiBalance(inputs: Inputs, policy: Policy, t: LeaveTypeWithAllowance, userId: string, year: number): ApiBalance[] {
  if (t.archived && !inputs.allowanceRow(userId, t.id, year) && !inputs.hasBooked(userId, t.id, year)) return [];
  const b = inputs.balance(policy, t, userId, year);
  const base = { userId, leaveTypeId: t.id, year, tracked: b.tracked, used: b.used, pending: b.pending };
  if (!b.tracked) return [{ ...base, allowance: null, carriedOver: null, adjustment: null, total: null, carriedOut: null, remaining: null }];
  return [{ ...base, allowance: b.allowance, carriedOver: b.carriedOver, adjustment: b.adjustment, total: b.total, carriedOut: b.carriedOut, remaining: b.remaining }];
}

/**
 * Balances for one year (default: the current year in the company's time zone), for
 * every active person, or for one person (active or not), computed exactly as the
 * dashboard computes them. Every active leave type is listed, and an archived one only
 * where the person has an allowance row or booked days for it. Six queries: settings,
 * leave types and people in parallel, then allowance rows, booked-day sums and the
 * allowance rules; a seventh reads the people's departments and levels when the
 * company has rules.
 *
 * Fails with `forbidden`, or `policy_unavailable` when the company's policy is unknown.
 */
export async function listBalancesForApi(
  ctx: ServiceContext,
  client: ApiClient,
  q: { year?: number; userId?: string },
): Promise<ServiceResult<{ year: number; data: ApiBalance[] }>> {
  return attempt(async () => {
    assertScope(client, "read");
    const [settings, types, people] = await Promise.all([
      findCompanySettings(ctx.db, client.companyId),
      listLeaveTypesWithAllowance(ctx.db, client.companyId),
      listBalanceSubjects(ctx.db, client.companyId, q.userId),
    ]);
    if (!settings) throw new DomainError("no_company");
    const policy = resolveAllowancePolicy(settings.allowancePolicy);
    const year = q.year ?? yearInTimeZone(settings.timezone, ctx.now());
    const userIds = people.map((p) => p.id);
    const [allowanceRows, bookedRows, defaults] = await Promise.all([
      listAllowances(ctx.db, { userIds, years: allowanceYearsFor([year]) }),
      sumBookedDays(ctx.db, { userIds, years: [year] }),
      loadAllowanceDefaults(ctx.db, client.companyId, userIds),
    ]);
    const inputs = balanceInputs(allowanceRows, bookedRows, defaults);
    return { year, data: userIds.flatMap((userId) => types.flatMap((t) => apiBalance(inputs, policy, t, userId, year))) };
  });
}

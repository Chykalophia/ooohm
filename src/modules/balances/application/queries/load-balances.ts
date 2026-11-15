import "server-only";
import { type AllowancePolicy, type Balance, type LeaveTypeAllowanceSettings } from "../../domain/allowance-policy";
import { type AllowanceDefaults } from "../../domain/allowance-rules";
import { allowanceYearsFor, type BalanceInputs, balanceInputs, type BalanceScope } from "../../domain/allowance";
import { resolveAllowancePolicy } from "../../domain/policy-registry";
import type { BalancesStore } from "../ports";
import { loadAllowanceDefaults } from "./load-allowance-defaults";

/**
 * The balance inputs (allowance rows, booked days and the people's defaults) for these
 * people of the company, leave types and years: three reads in parallel, then pure
 * lookups. Another company's people read as having no rows.
 *
 * @param defaults The people's defaults when the caller already loaded them.
 */
export async function loadBalanceInputs(
  store: Pick<BalancesStore, "allowances" | "rules">,
  companyId: string,
  scope: Omit<BalanceScope, "companyId">,
  defaults?: AllowanceDefaults,
): Promise<BalanceInputs> {
  const { years, ...rest } = scope;
  const [allowanceRows, bookedRows, loaded] = await Promise.all([
    store.allowances.list({ ...rest, companyId, years: allowanceYearsFor(years) }),
    store.allowances.sumBooked({ ...rest, companyId, years }),
    defaults ?? loadAllowanceDefaults(store.rules, companyId, scope.userIds),
  ]);
  return balanceInputs(allowanceRows, bookedRows, loaded);
}

/** A balance lookup for one policy: by person, leave type and year. */
export type BalanceLookup = (userId: string, leaveTypeId: string, year: number) => Balance;

/**
 * Balances of many people, leave types and years at once, computed exactly as the
 * dashboard computes each one. For bulk reads such as the leave report and the TimeOff
 * import's reconciliation.
 *
 * @returns A lookup by person, leave type (one of `leaveTypes`) and year (one of `years`).
 * @throws DomainError `policy_unavailable` when the policy is unknown.
 */
export async function loadBalances(
  store: Pick<BalancesStore, "allowances" | "rules">,
  scope: {
    companyId: string;
    allowancePolicy: string;
    leaveTypes: readonly (LeaveTypeAllowanceSettings & { id: string })[];
    userIds: readonly string[];
    years: readonly number[];
  },
): Promise<BalanceLookup> {
  const policy: AllowancePolicy = resolveAllowancePolicy(scope.allowancePolicy);
  const leaveTypeIds = scope.leaveTypes.map((t) => t.id);
  const inputs = await loadBalanceInputs(store, scope.companyId, { userIds: scope.userIds, years: scope.years, leaveTypeIds });
  const types = new Map(scope.leaveTypes.map((t) => [t.id, t]));
  return (userId, leaveTypeId, year) => {
    const type = types.get(leaveTypeId);
    if (!type) throw new Error(`Leave type ${leaveTypeId} was not loaded.`);
    return inputs.balance(policy, type, userId, year);
  };
}

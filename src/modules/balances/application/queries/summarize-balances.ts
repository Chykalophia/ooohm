import "server-only";
import type { AllowanceDefaults } from "../../domain/allowance-rules";
import { allowanceRecord } from "../../domain/allowance";
import { resolveAllowancePolicy } from "../../domain/policy-registry";
import type { BalanceSummary } from "../dto";
import type { BalancesStore, LeaveTypeWithAllowance } from "../ports";
import { loadBalanceInputs } from "./load-balances";

/**
 * A person's balance of every leave type in `loaded.types` for one year, for a caller
 * that already loaded the company's settings and leave types (the dashboard, an
 * admin's view of a person): allowance rows, booked-day sums and the person's defaults
 * (skipped when `loaded.defaults` is passed) in parallel, whatever the number of types
 * or requests.
 *
 * Every active type gets an item. An archived type gets one only when the person has
 * an allowance row or approved or pending days of it in the year, so retiring a type
 * never hides days already granted or used, and quietly drops it everywhere else.
 *
 * @throws DomainError `policy_unavailable`, before any read, when the policy is unknown.
 */
export async function summarizeBalances(
  store: Pick<BalancesStore, "allowances" | "rules">,
  person: { id: string; companyId: string },
  loaded: { allowancePolicy: string; types: readonly LeaveTypeWithAllowance[]; year: number; defaults?: AllowanceDefaults },
): Promise<BalanceSummary> {
  const policy = resolveAllowancePolicy(loaded.allowancePolicy);
  const { year } = loaded;
  const inputs = await loadBalanceInputs(store, person.companyId, { userIds: [person.id], years: [year] }, loaded.defaults);
  return {
    year,
    items: loaded.types.flatMap((t) => {
      const row = inputs.allowanceRow(person.id, t.id, year);
      if (t.archived && !row && !inputs.hasBooked(person.id, t.id, year)) return [];
      return {
        leaveTypeId: t.id,
        name: t.name,
        color: t.color,
        archived: t.archived,
        balance: inputs.balance(policy, t, person.id, year),
        row: row ? allowanceRecord(row) : null,
      };
    }),
  };
}

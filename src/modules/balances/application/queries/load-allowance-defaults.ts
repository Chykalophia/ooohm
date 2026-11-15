import "server-only";
import { type AllowanceDefaults, allowanceDefaultsFrom } from "../../domain/allowance-rules";
import type { AllowanceRuleRepository } from "../ports";

/**
 * The company's {@link AllowanceDefaults} for `userIds`: one read for the rules, and one
 * more for where the people sit only when the company has any. The single way any
 * balance reads a leave type's default allowance.
 */
export async function loadAllowanceDefaults(rules: AllowanceRuleRepository, companyId: string, userIds: readonly string[]): Promise<AllowanceDefaults> {
  const all = await rules.list(companyId);
  if (all.length === 0) return allowanceDefaultsFrom(all, new Map());
  return allowanceDefaultsFrom(all, await rules.placements(companyId, userIds));
}

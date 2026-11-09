/**
 * Allowance rules: a yearly allowance for one leave type that replaces the type's
 * default for everyone in a department, at a level (an intern, a senior), or both.
 *
 * A rule only changes the default. A person's own allowance row for a year still wins,
 * as it does over the type's default (see `AnnualCalendarYearPolicy`); the services
 * keep rows that were following the rules in step when the rules change.
 */
import { DomainError } from "./errors";
import { MAX_ALLOWANCE_DAYS, normalizeDayAmount } from "./leave-type-settings";

/** Where a person sits, as far as allowance rules go. */
export interface Placement {
  departmentId: string | null;
  levelId: string | null;
}

export interface AllowanceRule extends Placement {
  leaveTypeId: string;
  days: number;
}

/** How specific a rule is for `placement`: 0 when it does not apply. */
function specificity(rule: AllowanceRule, placement: Placement): number {
  if (rule.departmentId !== null && rule.departmentId !== placement.departmentId) return 0;
  if (rule.levelId !== null && rule.levelId !== placement.levelId) return 0;
  return (rule.levelId !== null ? 2 : 0) + (rule.departmentId !== null ? 1 : 0);
}

/**
 * The rule that sets `placement`'s allowance of a leave type: the most specific one
 * that applies. A department and level rule beats a level rule, which beats a
 * department rule, since a level says more about what someone is owed (a senior
 * developer and a senior designer) than the team they sit in.
 */
export function ruleFor(rules: readonly AllowanceRule[], leaveTypeId: string, placement: Placement): AllowanceRule | undefined {
  let best: AllowanceRule | undefined;
  let bestScore = 0;
  for (const rule of rules) {
    if (rule.leaveTypeId !== leaveTypeId) continue;
    const score = specificity(rule, placement);
    if (score > bestScore) [best, bestScore] = [rule, score];
  }
  return best;
}

/** The default yearly allowance of `leaveType` for someone at `placement`: their rule's, else the type's own. */
export function defaultAllowanceFor(
  leaveType: { id: string; defaultAllowanceDays: number | null },
  placement: Placement,
  rules: readonly AllowanceRule[],
): number | null {
  return ruleFor(rules, leaveType.id, placement)?.days ?? leaveType.defaultAllowanceDays;
}

/**
 * Checks a rule as an admin enters it.
 *
 * @throws DomainError `invalid_input` for a rule naming neither a department nor a
 *   level, or days that are negative, over {@link MAX_ALLOWANCE_DAYS} or finer than a tenth.
 */
export function normalizeAllowanceRule(input: Placement & { days: number }): Placement & { days: number } {
  if (input.departmentId === null && input.levelId === null) {
    throw new DomainError("invalid_input", "Pick a department, a level, or both.", { field: "departmentId" });
  }
  return { departmentId: input.departmentId, levelId: input.levelId, days: normalizeDayAmount(input.days, { min: 0, max: MAX_ALLOWANCE_DAYS }) };
}

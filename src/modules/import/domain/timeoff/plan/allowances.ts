/**
 * Planning step: the pool type's allowance rows, and TimeOff's balance for every person
 * and year the import must reproduce.
 */
import { addDays } from "@/shared/kernel/day-amounts";
import { MAX_ALLOWANCE_DAYS } from "@/shared/kernel/leave-type-settings";
import { isTimeOffApproved, timeOffDeductedDays, type TimeOffWorkCalendar, timeOffYearBalance, type TimeOffYearBalance } from "../balance";
import type { TimeOffAdjustment, TimeOffDepartment, TimeOffLeave, TimeOffUser } from "../source";
import { refuse, yearOf } from "./rules";
import type { ExpectedBalance, ImportPlanOptions, KeptUser, PlannedAllowance, PlannedPerson, Warn } from "./types";

export interface AllowanceContext {
  options: Pick<ImportPlanOptions, "currentYear">;
  poolKey: string;
  poolDefault: number | null;
  people: readonly PlannedPerson[];
  departmentById: ReadonlyMap<number, TimeOffDepartment>;
  poolLeavesOf: ReadonlyMap<number, TimeOffLeave[]>;
  calendarOf: ReadonlyMap<number, TimeOffWorkCalendar>;
  adjustments: readonly TimeOffAdjustment[];
  /** `${userId}|${year}` → TimeOff's adjustment row (the last one, when the file repeats it). */
  adjustmentOf: ReadonlyMap<string, TimeOffAdjustment>;
}

/**
 * The years TimeOff has something for (pooled leave, an adjustment) and, for someone
 * employed, the years OOOhm needs a row in.
 */
export function balanceYears(u: TimeOffUser, isActive: boolean, poolLeaves: readonly TimeOffLeave[], c: AllowanceContext): Set<number> {
  const years = new Set<number>();
  for (const l of poolLeaves) for (let y = yearOf(l.dateStart); y <= yearOf(l.dateEnd); y++) years.add(y);
  for (const a of c.adjustments) if (a.userId === u.id) years.add(a.year);
  const startYear = u.startDate !== null ? yearOf(u.startDate) : null;
  if (isActive) {
    years.add(c.options.currentYear);
    // A future hire needs a row up to their start year, or the pool type would be untracked for them.
    if (startYear !== null && startYear > c.options.currentYear) years.add(startYear);
    // With a default, the rollover reads a missing closing year as the default, which is
    // not TimeOff's figure in a start year: give that year a row of its own.
    if (c.poolDefault !== null && (startYear === null || startYear < c.options.currentYear)) years.add(c.options.currentYear - 1);
  }
  return years;
}

/**
 * The years that get an allowance row: every year from the first to the last of
 * `years`, within employment. Years before the start get no row, except from the current
 * year on for a future hire: those get a zero row (TimeOff shows 0 before someone starts).
 */
export function allowanceYears(u: TimeOffUser, years: ReadonlySet<number>, currentYear: number): Set<number> {
  let lo = Math.min(...years);
  let hi = Math.max(...years);
  if (u.startDate !== null) lo = Math.max(lo, Math.min(yearOf(u.startDate), currentYear));
  if (u.endDate !== null) hi = Math.min(hi, yearOf(u.endDate));
  const out = new Set<number>();
  for (let year = lo; year <= hi; year++) out.add(year);
  return out;
}

/** The allowance row of one year, from TimeOff's balance for it. */
export function allowanceRow(kept: KeptUser, year: number, nominal: number, timeoff: TimeOffYearBalance, poolKey: string): PlannedAllowance {
  if (timeoff.beforeStart) {
    return { personKey: kept.user.id, leaveTypeKey: poolKey, year, days: nominal, adjustmentDays: -nominal || 0, carriedOverDays: 0, timeoffAdjustment: 0, employmentAdjustment: -nominal || 0 };
  }
  const adjustmentDays = addDays(timeoff.adjustment, timeoff.employmentAdjustment);
  for (const [what, value] of [["adjustment", adjustmentDays], ["carried-over allowance", timeoff.carriedOver]] as const) {
    if (Math.abs(value) > MAX_ALLOWANCE_DAYS) refuse(`${kept.email}'s ${what} for ${year} is ${value} days; OOOhm allows at most ${MAX_ALLOWANCE_DAYS}.`);
  }
  return {
    personKey: kept.user.id,
    leaveTypeKey: poolKey,
    year,
    days: nominal,
    adjustmentDays,
    carriedOverDays: timeoff.carriedOver,
    timeoffAdjustment: timeoff.adjustment,
    employmentAdjustment: timeoff.employmentAdjustment,
  };
}

/** The department allowance a person's pool starts from (0 without a department, with a warning). */
function nominalAllowance({ user: u, email }: KeptUser, c: AllowanceContext, warn: Warn): number {
  const dept = u.departmentId !== null ? c.departmentById.get(u.departmentId) : undefined;
  if (!dept) warn({ code: "no_department", email, message: `${email} has no department in TimeOff, so no allowance (0 days).` });
  const nominal = dept?.allowance ?? 0;
  if (nominal < 0 || nominal > MAX_ALLOWANCE_DAYS) refuse(`Department "${dept?.name}" has an allowance of ${nominal} days; OOOhm allows 0 to ${MAX_ALLOWANCE_DAYS}.`);
  return nominal;
}

/** One person's expected balances and allowance rows. */
function personAllowances(kept: KeptUser, c: AllowanceContext, warn: Warn): { allowances: PlannedAllowance[]; expected: ExpectedBalance[] } {
  const u = kept.user;
  const person = c.people.find((p) => p.key === u.id)!;
  const poolLeaves = c.poolLeavesOf.get(u.id) ?? [];
  const years = balanceYears(u, person.isActive, poolLeaves, c);
  if (years.size === 0) return { allowances: [], expected: [] };
  const nominal = nominalAllowance(kept, c, warn);
  const rowYears = allowanceYears(u, years, c.options.currentYear);
  const out = { allowances: [] as PlannedAllowance[], expected: [] as ExpectedBalance[] };
  for (const year of [...new Set([...rowYears, ...years])].sort((a, b) => a - b)) {
    const adj = c.adjustmentOf.get(`${u.id}|${year}`);
    const used = poolLeaves
      .filter((l) => isTimeOffApproved(l.status))
      .reduce((sum, l) => addDays(sum, timeOffDeductedDays(l, c.calendarOf.get(u.id)!, year)), 0);
    const timeoff = timeOffYearBalance({
      year,
      nominal,
      startDate: u.startDate,
      endDate: u.endDate,
      adjustment: adj?.adjustment ?? 0,
      carriedOver: adj?.carriedOverAllowance ?? 0,
      used,
    });
    out.expected.push({ personKey: u.id, year, timeoff });
    if (rowYears.has(year)) out.allowances.push(allowanceRow(kept, year, nominal, timeoff, c.poolKey));
  }
  return out;
}

/** Every kept person's allowance rows and expected balances, in TimeOff id order. */
export function planAllowances(kept: readonly KeptUser[], c: AllowanceContext, warn: Warn): { allowances: PlannedAllowance[]; expected: ExpectedBalance[] } {
  const allowances: PlannedAllowance[] = [];
  const expected: ExpectedBalance[] = [];
  for (const k of kept) {
    const mine = personAllowances(k, c, warn);
    allowances.push(...mine.allowances);
    expected.push(...mine.expected);
  }
  return { allowances, expected };
}

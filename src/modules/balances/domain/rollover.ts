/**
 * The year rollover's decisions for one person, pure: which leave types it looks at,
 * and what it does with each one's next-year row. The use case reads and writes.
 */
import type { LeaveTypeAllowanceSettings } from "./allowance-policy";
import type { Allowance, NewAllowance } from "./allowance";

/** A leave type with the person's own default (from {@link AllowanceDefaults}) in `defaultAllowanceDays`. */
export type RolloverLeaveType = LeaveTypeAllowanceSettings & { id: string };

/** The leave types one person's rollover touches. */
export interface RolloverScope<T extends RolloverLeaveType> {
  /** Types whose closing-year balance carries into next year. */
  carryTypes: T[];
  /** Types whose next-year row is looked at: those that carry, and those without a default. */
  types: T[];
  /** Types that get a current-year row from their default (only when creating defaults). */
  defaultTypes: (T & { defaultAllowanceDays: number })[];
}

/**
 * Which of `own` (the person's types, each with their own default) the rollover
 * touches. Someone who joined after the closing year had no balance in it, so carries
 * nothing; a re-carry (`createDefaults` false) creates no current-year rows.
 */
export function rolloverScope<T extends RolloverLeaveType>(
  own: readonly T[],
  job: { createDefaults: boolean; joinedYear: number; closingYear: number },
): RolloverScope<T> {
  const noDefaultTypes = own.filter((t) => t.defaultAllowanceDays === null);
  const defaultTypes = job.createDefaults
    ? own.flatMap((t) => (t.defaultAllowanceDays !== null ? [{ ...t, defaultAllowanceDays: t.defaultAllowanceDays }] : []))
    : [];
  const carryTypes = job.joinedYear <= job.closingYear ? own.filter((t) => t.carryoverEnabled) : [];
  const carryIds = new Set(carryTypes.map((t) => t.id));
  return { carryTypes, types: [...carryTypes, ...noDefaultTypes.filter((t) => !carryIds.has(t.id))], defaultTypes };
}

/** What the rollover does with one leave type's next-year row. */
export type RolloverStep =
  | { kind: "keep" }
  | { kind: "carry"; allowance: Allowance; carriedOverDays: number }
  | { kind: "create"; allowance: NewAllowance & { carriedOverDays: number }; reason: "carryover" | "allowance_created" };

/**
 * The step for one leave type.
 *
 * - An existing next-year row takes the carry when it differs (and is kept otherwise).
 * - With a default and nothing to carry, the default already covers next year (the
 *   current-year step creates that row when next year is current).
 * - Without a default, the person's latest row is copied forward, carry or not, so
 *   next year has a row of its own (the balance would inherit it anyway) that an admin
 *   can see and edit. Nobody who never had a row gets one.
 *
 * @param input.carry The policy's carryover out of the closing year, or `null` when the type carries nothing.
 * @param input.latestDays `days` of the person's latest row in or before the closing year.
 */
export function rolloverStep(input: {
  userId: string;
  leaveType: RolloverLeaveType;
  nextYear: number;
  carry: number | null;
  existing: Allowance | undefined;
  latestDays: number | undefined;
}): RolloverStep {
  const { carry, existing, leaveType } = input;
  if (existing) {
    if (carry === null || existing.carriedOverDays === carry) return { kind: "keep" };
    return { kind: "carry", allowance: existing, carriedOverDays: carry };
  }
  if (!carry && leaveType.defaultAllowanceDays !== null) return { kind: "keep" };
  const days = leaveType.defaultAllowanceDays ?? input.latestDays;
  if (days === undefined) return { kind: "keep" };
  return {
    kind: "create",
    allowance: { userId: input.userId, leaveTypeId: leaveType.id, year: input.nextYear, days, carriedOverDays: carry ?? 0 },
    reason: carry ? "carryover" : "allowance_created",
  };
}

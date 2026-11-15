import { addDays } from "@/shared/kernel/day-amounts";
import { splitLeaveDaysByYear, type WorkCalendar, type YearDays } from "@/shared/kernel/leave-days";
import type { LeaveRange } from "@/shared/kernel/leave-range";
import { ANNUAL_CALENDAR_YEAR } from "@/shared/kernel/allowance-policy-keys";
import type { AllowancePolicy, Balance, BalanceInput, LeaveTypeAllowanceSettings } from "./allowance-policy";

/**
 * v1 policy: a flat yearly allowance per leave type, reset on Jan 1.
 *
 * - A type is tracked when it counts against allowance and the person has an
 *   allowance row for the year, or the type has a default allowance, or (no default)
 *   the person has a row for an earlier year.
 * - allowance = the row's `days`, else the type's default, else the `days` of the
 *   person's latest earlier row. Without that last step a type with no default would
 *   turn unlimited in any year the rollover had not yet given a row (booking ahead,
 *   or the January part of a request over New Year). Carryover and adjustment come
 *   from the year's own row (0 without one).
 * - used = approved days in the year; pending = pending days in the year; both read
 *   from each request's stored per-year split, so a request over New Year counts in
 *   each year separately.
 * - remaining = total - used - pending - carriedOut, where carriedOut is what the
 *   rollover already moved into the next year. Without it, leave booked late into a
 *   closed year could spend days that were also carried forward.
 * - Carryover: when enabled, the closing year's remaining before any carry (remaining
 *   + carriedOut), clamped to `[0, carryoverMaxDays]` (no upper bound when the max is
 *   null).
 */
export class AnnualCalendarYearPolicy implements AllowancePolicy {
  readonly key = ANNUAL_CALENDAR_YEAR;

  periodsFor(range: LeaveRange, calendar: WorkCalendar): YearDays[] {
    return splitLeaveDaysByYear(range, calendar);
  }

  balance({ leaveType, allowance, inheritedDays = null, booked, carriedOut: out = 0 }: BalanceInput): Balance {
    const used = addDays(booked.approved);
    const pending = addDays(booked.pending);
    const base = allowance?.days ?? leaveType.defaultAllowanceDays ?? inheritedDays;
    if (!leaveType.countsAgainstAllowance || base === null) return { tracked: false, used, pending };

    const carriedOver = allowance?.carriedOverDays ?? 0;
    const adjustment = allowance?.adjustmentDays ?? 0;
    const total = addDays(base, carriedOver, adjustment);
    const carriedOut = addDays(out);
    return {
      tracked: true,
      allowance: addDays(base),
      carriedOver: addDays(carriedOver),
      adjustment: addDays(adjustment),
      total,
      used,
      pending,
      carriedOut,
      remaining: addDays(total, -used, -pending, -carriedOut),
    };
  }

  carryover(leaveType: LeaveTypeAllowanceSettings, closing: Balance): number | null {
    if (!leaveType.carryoverEnabled || !closing.tracked) return null;
    // What was left before any carry, so recomputing over an earlier carry is stable.
    const floor = Math.max(addDays(closing.remaining, closing.carriedOut), 0);
    return leaveType.carryoverMaxDays === null ? floor : Math.min(floor, addDays(leaveType.carryoverMaxDays));
  }
}

import type { Brand } from "@/shared/kernel/ids";
import { countLeaveDays, splitLeaveDaysByYear, type WorkCalendar, type YearDays } from "@/shared/kernel/leave-days";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import { createDateRange, type DateRange } from "./date-range";

/**
 * Working days of leave: never negative, with one decimal place (a half day is 0.5).
 * Weekends and company holidays never count.
 */
export type DayCount = Brand<number, "DayCount">;

/** `days` as a {@link DayCount}, or `invalid_input` when it is negative, not finite, or finer than a tenth. */
export function dayCount(days: number): ServiceResult<DayCount> {
  if (!Number.isFinite(days) || days < 0 || Math.round(days * 10) !== days * 10) {
    return err("invalid_input", "A day count is a non-negative number with one decimal place.");
  }
  return ok(days as DayCount);
}

/** The sum of day counts, kept to one decimal place. */
export function addDayCounts(...counts: readonly DayCount[]): DayCount {
  return (Math.round(counts.reduce((sum, d) => sum + d * 10, 0)) / 10) as DayCount;
}

/**
 * What `range` costs with `calendar`: every working weekday from start to end that is
 * not a company holiday, 0.5 for a half day. Fails as {@link createDateRange} for a
 * malformed range (a half day over several dates is `half_day_multi_day`), and with
 * `zero_days` when no day of it is a working day.
 */
export function countDays(range: DateRange, calendar: WorkCalendar): ServiceResult<DayCount> {
  const checked = createDateRange(range.startDate, range.endDate, range.dayPortion);
  if (!checked.ok) return checked;
  const days = countLeaveDays(checked.value, calendar);
  return days > 0 ? ok(days as DayCount) : err("zero_days");
}

/** {@link countDays} split by calendar year, as balances charge it; years with no working day are left out. */
export function countDaysByYear(range: DateRange, calendar: WorkCalendar): ServiceResult<readonly YearDays[]> {
  const checked = createDateRange(range.startDate, range.endDate, range.dayPortion);
  if (!checked.ok) return checked;
  const split = splitLeaveDaysByYear(checked.value, calendar);
  return split.length > 0 ? ok(split) : err("zero_days");
}

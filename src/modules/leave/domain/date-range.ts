import { spanInDays } from "@/domain/calendar-date";
import { assertValidRange, type DayPortion, type LeaveRange } from "@/shared/kernel/leave-range";
import { fromDomainError, ok, type ServiceResult } from "@/shared/lib/result";

/**
 * The dates a request covers, checked: real calendar dates, end on or after start, at
 * most {@link MAX_REQUEST_SPAN_DAYS} long, and a half day on one date only. A value: two
 * ranges with the same dates and portion are the same range ({@link sameRange}).
 */
export type DateRange = Readonly<LeaveRange>;

/**
 * A checked {@link DateRange}; `endDate` defaults to `startDate`.
 *
 * Fails with `invalid_input` (not a date, or an unknown portion), `invalid_date_range`
 * (end before start), `range_too_long` (over 366 days) or `half_day_multi_day`.
 */
export function createDateRange(startDate: string, endDate?: string | null, dayPortion: DayPortion = "full"): ServiceResult<DateRange> {
  const range: DateRange = { startDate, endDate: endDate || startDate, dayPortion };
  try {
    assertValidRange(range);
  } catch (error) {
    return fromDomainError(error);
  }
  return ok(range);
}

/** Whether two ranges are the same dates and portion. */
export function sameRange(a: DateRange, b: DateRange): boolean {
  return a.startDate === b.startDate && a.endDate === b.endDate && a.dayPortion === b.dayPortion;
}

/** Calendar days the range spans, both ends included. */
export function rangeLength(range: DateRange): number {
  return spanInDays(range.startDate, range.endDate);
}

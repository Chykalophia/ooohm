import { type CalendarDate, eachDate, fromEpochDay, isoWeekday, toEpochDay } from "./calendar-date";
import { DomainError } from "./errors";
import { assertValidRange, type LeaveRange } from "./leave-request";

/** The parts of a company's calendar that decide which days cost leave. */
export interface WorkCalendar {
  /** ISO weekdays that are working days (1 = Monday ... 7 = Sunday). */
  workingDays: readonly number[];
  /** Company holidays as `YYYY-MM-DD`. Dates outside the range are ignored. */
  holidays: Iterable<CalendarDate>;
}

/**
 * Working days a range consumes: every working weekday from start to end inclusive
 * that is not a company holiday. A half day (am/pm) counts 0.5.
 *
 * May return 0 (e.g. a weekend-only range); callers that must reject that use
 * {@link requireLeaveDays}.
 *
 * @throws DomainError from {@link assertValidRange} for a malformed range.
 */
export function countLeaveDays(range: LeaveRange, calendar: WorkCalendar): number {
  assertValidRange(range);
  const working = new Set(calendar.workingDays);
  const holidays = new Set(calendar.holidays);
  let days = 0;
  for (const date of eachDate(range.startDate, range.endDate)) {
    if (working.has(isoWeekday(date)) && !holidays.has(date)) days++;
  }
  return range.dayPortion === "full" ? days : days * 0.5;
}

/** How far {@link nextWorkingDay} looks ahead, in calendar days, including `from`. */
export const WORKING_DAY_LOOKAHEAD = 31;

/**
 * The first working day on or after `from` that is not a company holiday, within
 * {@link WORKING_DAY_LOOKAHEAD} days. Returns `from` when there is none in that window
 * (e.g. a company with no working days), so callers always get a date.
 *
 * @param calendar Holidays need only cover the look-ahead window.
 */
export function nextWorkingDay(from: CalendarDate, calendar: WorkCalendar): CalendarDate {
  const working = new Set(calendar.workingDays);
  const holidays = new Set(calendar.holidays);
  const start = toEpochDay(from);
  for (let offset = 0; offset < WORKING_DAY_LOOKAHEAD; offset++) {
    const date = fromEpochDay(start + offset);
    if (working.has(isoWeekday(date)) && !holidays.has(date)) return date;
  }
  return from;
}

/**
 * {@link countLeaveDays}, but a request that costs nothing is an error: it would
 * never show on a balance and almost always means the wrong dates were picked.
 *
 * @throws DomainError `zero_days` when the range has no working days.
 */
export function requireLeaveDays(range: LeaveRange, calendar: WorkCalendar): number {
  const days = countLeaveDays(range, calendar);
  if (days <= 0) throw new DomainError("zero_days");
  return days;
}

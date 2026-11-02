import { type CalendarDate, eachDate, fromEpochDay, isoWeekday, toEpochDay } from "./calendar-date";
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
 * May return 0 (e.g. a weekend-only range). Submit and the live preview refuse such a
 * request with `zero_days` when the allowance policy's split
 * ({@link splitLeaveDaysByYear} in v1) comes back empty.
 *
 * @throws DomainError from {@link assertValidRange} for a malformed range.
 */
export function countLeaveDays(range: LeaveRange, calendar: WorkCalendar): number {
  return splitLeaveDaysByYear(range, calendar).reduce((sum, part) => sum + part.days, 0);
}

/** The days a request costs in one calendar year. */
export interface YearDays {
  year: number;
  days: number;
}

/**
 * {@link countLeaveDays}, split by calendar year: a request from Thu Dec 31 to Mon
 * Jan 4 costs 1 day in the first year and 1 in the next (weekend and Jan 1 aside, if
 * Jan 1 is a holiday). Years in which the range has no working day are left out, so
 * every entry has `days > 0`. Ordered by year; the sum equals {@link countLeaveDays}.
 *
 * @throws DomainError from {@link assertValidRange} for a malformed range.
 */
export function splitLeaveDaysByYear(range: LeaveRange, calendar: WorkCalendar): YearDays[] {
  assertValidRange(range);
  const working = new Set(calendar.workingDays);
  const holidays = new Set(calendar.holidays);
  const perDay = range.dayPortion === "full" ? 1 : 0.5;
  const out: YearDays[] = [];
  for (const date of eachDate(range.startDate, range.endDate)) {
    if (!working.has(isoWeekday(date)) || holidays.has(date)) continue;
    const year = Number(date.slice(0, 4));
    const last = out.at(-1);
    if (last?.year === year) last.days += perDay;
    else out.push({ year, days: perDay });
  }
  return out;
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

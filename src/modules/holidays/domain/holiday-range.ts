/**
 * Holidays that span several days. A holiday is stored one row per day, so day counting,
 * the calendar and the API never see ranges; a run added together shares one name, and
 * the admin screen shows back-to-back days with one name as one entry.
 */
import { type CalendarDate, eachDate, isCalendarDate, spanInDays, toEpochDay } from "@/domain/calendar-date";
import { DomainError } from "@/domain/errors";
import { assertHolidayDate } from "@/domain/holidays";

/** The longest run of days one entry can add (a shutdown, a festive break). */
export const HOLIDAY_RANGE_MAX_DAYS = 31;

/**
 * Every date from `start` to `end`, inclusive, for a holiday that spans several days
 * (an end-of-year shutdown). Weekends inside it are included, so the calendar shows
 * the whole break; they never counted anyway.
 *
 * @throws DomainError `invalid_input` for a bad date, an end before the start, or a
 *   run longer than {@link HOLIDAY_RANGE_MAX_DAYS}.
 */
export function holidayRangeDates(start: string, end: string): CalendarDate[] {
  assertHolidayDate(start);
  if (!isCalendarDate(end)) throw new DomainError("invalid_input", "Holiday dates are real calendar dates.", { field: "endDate" });
  if (end < start) throw new DomainError("invalid_input", "The last day comes on or after the first.", { field: "endDate" });
  if (spanInDays(start, end) > HOLIDAY_RANGE_MAX_DAYS) {
    throw new DomainError("invalid_input", `A holiday spans at most ${HOLIDAY_RANGE_MAX_DAYS} days.`, { field: "endDate" });
  }
  return eachDate(start, end);
}

/** A run of back-to-back days sharing one name, shown and managed as one holiday. */
export interface HolidayGroup<T extends { id: string; date: string; name: string }> {
  name: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  days: T[];
}

/**
 * Groups holidays (sorted by date) into runs of consecutive days with the same name,
 * so a two-week shutdown stored as fourteen days reads as one entry. A different
 * holiday in the middle (Christmas inside the shutdown) splits the run.
 */
export function groupHolidays<T extends { id: string; date: string; name: string }>(rows: readonly T[]): HolidayGroup<T>[] {
  const groups: HolidayGroup<T>[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last.name === row.name && toEpochDay(row.date) === toEpochDay(last.endDate) + 1) {
      last.endDate = row.date;
      last.days.push(row);
    } else {
      groups.push({ name: row.name, startDate: row.date, endDate: row.date, days: [row] });
    }
  }
  return groups;
}

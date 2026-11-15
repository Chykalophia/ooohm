/**
 * Company holidays: the name, date and year checks the admin screens, the calendar and
 * the TimeOff import share (the ranges and the US federal list are in the holidays
 * module's domain). A holiday never counts as a leave day, but only for requests
 * submitted after it exists: submitted requests keep the per-year day split stored
 * with them, so adding or deleting a holiday never changes a past balance.
 */
import { type CalendarDate, isCalendarDate } from "./calendar-date";
import { DomainError } from "./errors";
import { oneLine } from "./text";

export const HOLIDAY_NAME_MAX_LENGTH = 100;

/** @throws DomainError `invalid_input` when blank or longer than {@link HOLIDAY_NAME_MAX_LENGTH}. */
export function normalizeHolidayName(raw: string): string {
  const name = oneLine(raw);
  if (name.length === 0 || name.length > HOLIDAY_NAME_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Holiday names are 1 to ${HOLIDAY_NAME_MAX_LENGTH} characters.`, { field: "name" });
  }
  return name;
}

/** @throws DomainError `invalid_input` for anything but a real `YYYY-MM-DD` date. */
export function assertHolidayDate(date: string): asserts date is CalendarDate {
  if (!isCalendarDate(date)) throw new DomainError("invalid_input", "Holiday dates are real calendar dates.", { field: "date" });
}

/** Years the holiday list can be browsed and filled for. */
export const HOLIDAY_YEAR_MIN = 2000;
export const HOLIDAY_YEAR_MAX = 2100;

export function isHolidayYear(year: number): boolean {
  return Number.isInteger(year) && year >= HOLIDAY_YEAR_MIN && year <= HOLIDAY_YEAR_MAX;
}

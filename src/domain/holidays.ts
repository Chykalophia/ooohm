/**
 * Company holidays: validation and the optional list of US federal holidays an admin
 * can add in one step. A holiday never counts as a leave day, but only for requests
 * submitted after it exists: submitted requests keep the per-year day split stored
 * with them, so adding or deleting a holiday never changes a past balance.
 */
import { type CalendarDate, fromEpochDay, isCalendarDate, isoWeekday, toEpochDay } from "./calendar-date";
import { DomainError } from "./errors";

export const HOLIDAY_NAME_MAX_LENGTH = 100;

/** @throws DomainError `invalid_input` when blank or longer than {@link HOLIDAY_NAME_MAX_LENGTH}. */
export function normalizeHolidayName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > HOLIDAY_NAME_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Holiday names are 1 to ${HOLIDAY_NAME_MAX_LENGTH} characters.`);
  }
  return name;
}

/** @throws DomainError `invalid_input` for anything but a real `YYYY-MM-DD` date. */
export function assertHolidayDate(date: string): asserts date is CalendarDate {
  if (!isCalendarDate(date)) throw new DomainError("invalid_input", "Holiday dates are real calendar dates.");
}

/** Years the holiday list can be browsed and filled for. */
export const HOLIDAY_YEAR_MIN = 2000;
export const HOLIDAY_YEAR_MAX = 2100;

export function isHolidayYear(year: number): boolean {
  return Number.isInteger(year) && year >= HOLIDAY_YEAR_MIN && year <= HOLIDAY_YEAR_MAX;
}

export interface HolidayDraft {
  date: CalendarDate;
  name: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (year: number, month: number, day: number): CalendarDate => `${year}-${pad(month)}-${pad(day)}`;

/** The `n`th (1-based) ISO `weekday` of a month, or the last one when `n` is -1. */
function nthWeekday(year: number, month: number, weekday: number, n: number): CalendarDate {
  if (n === -1) {
    const lastDay = toEpochDay(ymd(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1)) - 1;
    const back = (isoWeekday(fromEpochDay(lastDay)) - weekday + 7) % 7;
    return fromEpochDay(lastDay - back);
  }
  const first = toEpochDay(ymd(year, month, 1));
  const ahead = (weekday - isoWeekday(fromEpochDay(first)) + 7) % 7;
  return fromEpochDay(first + ahead + (n - 1) * 7);
}

/** Where a fixed-date holiday is observed: Saturday moves to Friday, Sunday to Monday. */
function observed(date: CalendarDate): { date: CalendarDate; moved: boolean } {
  const weekday = isoWeekday(date);
  if (weekday === 6) return { date: fromEpochDay(toEpochDay(date) - 1), moved: true };
  if (weekday === 7) return { date: fromEpochDay(toEpochDay(date) + 1), moved: true };
  return { date, moved: false };
}

/**
 * The eleven US federal holidays observed in `year` (5 U.S.C. 6103), on the day they
 * are observed: a fixed-date holiday on a Saturday is observed the Friday before and
 * on a Sunday the Monday after, and is then named "(observed)". New Year's Day of the
 * next year belongs here when it is observed on Dec 31; this year's belongs to the
 * year before when it is.
 */
export function usFederalHolidays(year: number): HolidayDraft[] {
  const fixed = (date: CalendarDate, name: string): HolidayDraft => {
    const o = observed(date);
    return { date: o.date, name: o.moved ? `${name} (observed)` : name };
  };
  const all: HolidayDraft[] = [
    fixed(ymd(year, 1, 1), "New Year's Day"),
    { date: nthWeekday(year, 1, 1, 3), name: "Birthday of Martin Luther King, Jr." },
    { date: nthWeekday(year, 2, 1, 3), name: "Washington's Birthday" },
    { date: nthWeekday(year, 5, 1, -1), name: "Memorial Day" },
    fixed(ymd(year, 6, 19), "Juneteenth National Independence Day"),
    fixed(ymd(year, 7, 4), "Independence Day"),
    { date: nthWeekday(year, 9, 1, 1), name: "Labor Day" },
    { date: nthWeekday(year, 10, 1, 2), name: "Columbus Day" },
    fixed(ymd(year, 11, 11), "Veterans Day"),
    { date: nthWeekday(year, 11, 4, 4), name: "Thanksgiving Day" },
    fixed(ymd(year, 12, 25), "Christmas Day"),
    fixed(ymd(year + 1, 1, 1), "New Year's Day"),
  ];
  return all.filter((h) => h.date.startsWith(`${year}-`));
}

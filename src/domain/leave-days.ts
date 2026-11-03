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

/**
 * A submitted request's per-year split after the calendar changed, applying only what
 * the change itself made different: each open year (`firstOpenYear` and later) moves by
 * what the request counts with the new calendar minus what it counted with the old one,
 * and years before `firstOpenYear` keep what `stored` charged them (their balances are
 * settled and carried over). Applying the difference, rather than recounting from
 * scratch, leaves any earlier adjustment to the stored split alone. Ordered by year;
 * years left with no days are dropped, so every entry has `days > 0`, and an empty
 * result means the request now costs nothing.
 *
 * Known limit: a year never goes below 0, and what would have taken it below is not
 * kept. That only happens when the stored split already counted fewer days than the
 * calendar (an imported split, or one stored before recounts existed): taking such a year
 * to 0 and then undoing the change restores the calendar's count, not the smaller stored
 * one. Remembering it would need a per-year offset stored with the request.
 *
 * @param stored The split saved with the request.
 * @param before The split counted with the calendar before the change.
 * @param after The split counted with the calendar after the change.
 */
export function applyCalendarChange(
  stored: readonly YearDays[],
  before: readonly YearDays[],
  after: readonly YearDays[],
  firstOpenYear: number,
): YearDays[] {
  const daysIn = (split: readonly YearDays[], year: number) => split.find((y) => y.year === year)?.days ?? 0;
  const years = [...new Set([...stored, ...before, ...after].map((y) => y.year))].sort((a, b) => a - b);
  return years
    .map((year) => {
      const kept = daysIn(stored, year);
      if (year < firstOpenYear) return { year, days: kept };
      const moved = Math.round((kept + daysIn(after, year) - daysIn(before, year)) * 10) / 10;
      return { year, days: Math.max(0, moved) };
    })
    .filter((y) => y.days > 0);
}

/** Whether two per-year splits charge the same days to the same years. */
export function sameSplit(a: readonly YearDays[], b: readonly YearDays[]): boolean {
  return a.length === b.length && a.every((y, i) => y.year === b[i].year && y.days === b[i].days);
}

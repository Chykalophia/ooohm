/**
 * Calendar dates as `YYYY-MM-DD` strings.
 *
 * A leave day is a calendar day, not an instant, so it must never pass through a
 * local-time `Date`: `new Date("2026-03-08")` is midnight UTC, which is still March 7
 * in Chicago. All arithmetic here runs on UTC epoch days, which have no DST and no
 * offset, so a date string always round-trips unchanged.
 */
export type CalendarDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** UTC midnight of a date in ms. `Date.UTC` reads years 0-99 as 19xx, so the year is set explicitly. */
export function utcMs(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m, d);
  return t.getTime();
}

/** True for a well-formed `YYYY-MM-DD` string naming a real day (no Feb 30). */
export function isCalendarDate(value: string): value is CalendarDate {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const utc = new Date(utcMs(y, mo - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === mo - 1 && utc.getUTCDate() === d;
}

/** Days since 1970-01-01 for a valid calendar date. */
export function toEpochDay(date: CalendarDate): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(utcMs(y, m - 1, d) / MS_PER_DAY);
}

export function fromEpochDay(epochDay: number): CalendarDate {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: CalendarDate): number {
  // 1970-01-01 was a Thursday (ISO 4).
  return ((((toEpochDay(date) + 3) % 7) + 7) % 7) + 1;
}

/** Inclusive number of calendar days from `start` to `end` (1 when they are equal). */
export function spanInDays(start: CalendarDate, end: CalendarDate): number {
  return toEpochDay(end) - toEpochDay(start) + 1;
}

/** Every calendar date from `start` to `end`, inclusive. Empty when `end < start`. */
export function eachDate(start: CalendarDate, end: CalendarDate): CalendarDate[] {
  const out: CalendarDate[] = [];
  for (let day = toEpochDay(start), last = toEpochDay(end); day <= last; day++) out.push(fromEpochDay(day));
  return out;
}

/**
 * The date picker's grid and keyboard maths: pure functions over `YYYY-MM-DD` dates, no
 * DOM, so they are unit tested on their own (`tests/unit/date-picker-grid.test.ts`).
 */
import { type CalendarDate, fromEpochDay, isCalendarDate } from "@/domain/calendar-date";
import { addMonths, monthOf, type YearMonth } from "@/domain/calendar";

/** Six weeks, always, so the popup keeps its height from month to month. */
export const PICKER_DAYS = 42;

/**
 * The first and last days a picker can reach: the first and last that the shared
 * `isCalendarDate` accepts, so the picker never offers a day the server refuses
 * (unit tested against it at both edges).
 */
export const MIN_DATE: CalendarDate = "0100-01-01";
export const MAX_DATE: CalendarDate = "9999-12-31";

/** UTC midnight of a date in ms. `Date.UTC` reads years 0-99 as 19xx, so the year is set explicitly. */
export function utcMs(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m, d);
  return t.getTime();
}

/**
 * Days since 1970-01-01. The picker's own version of the domain's `toEpochDay`, right for
 * years 0-99 too, so grid cells just before `MIN_DATE` (0099-12 in the 0100-01 grid) come out right.
 */
export function pickerEpochDay(date: CalendarDate): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(utcMs(y, m - 1, d) / 86_400_000);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday (1970-01-01 was a Thursday). */
function weekday(date: CalendarDate): number {
  return ((((pickerEpochDay(date) + 3) % 7) + 7) % 7) + 1;
}

function clampDay(epochDay: number): number {
  return Math.min(Math.max(epochDay, pickerEpochDay(MIN_DATE)), pickerEpochDay(MAX_DATE));
}

export type PickerDay = { date: CalendarDate; inMonth: boolean };

/** The 42 days the popup shows for `month`: Monday-first weeks from the week holding the 1st. */
export function pickerGrid(month: YearMonth): PickerDay[] {
  // Monday-first and four-digit years, both. Near the last supported day the grid slides back
  // whole weeks until it ends on or before MAX_DATE, so 9999-12's grid stops at Sunday the 26th:
  // the last five days are reached by typing or the keyboard (an accepted edge, year 9999).
  const first = pickerEpochDay(`${month}-01`);
  const latest = pickerEpochDay(MAX_DATE) - (PICKER_DAYS - 1);
  const latestMonday = latest - (weekday(fromEpochDay(latest)) - 1);
  const start = Math.min(first - (weekday(`${month}-01`) - 1), latestMonday);
  return Array.from({ length: PICKER_DAYS }, (_, i) => {
    const date = fromEpochDay(start + i);
    return { date, inMonth: monthOf(date) === month };
  });
}

/** The keys that move focus in the grid (WAI-ARIA APG date picker dialog). */
export type GridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown";

const GRID_KEYS: ReadonlySet<string> = new Set<GridKey>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function isGridKey(key: string): key is GridKey {
  return GRID_KEYS.has(key);
}

/** The same day number `count` months later, clamped to that month's last day (Jan 31 + 1 = Feb 28). */
export function addMonthsClamped(date: CalendarDate, count: number): CalendarDate {
  const month = addMonths(monthOf(date), count);
  const last = fromEpochDay(pickerEpochDay(`${addMonths(month, 1)}-01`) - 1);
  const day = Math.min(Number(date.slice(8)), Number(last.slice(8)));
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** Where focus goes from `date` on `key`. `shift` turns PageUp/PageDown into a year. */
export function moveFocus(date: CalendarDate, key: GridKey, shift = false): CalendarDate {
  const moved = moveUnclamped(date, key, shift);
  return moved < MIN_DATE ? MIN_DATE : moved > MAX_DATE || moved.length > 10 ? MAX_DATE : moved;
}

function moveUnclamped(date: CalendarDate, key: GridKey, shift: boolean): CalendarDate {
  const day = pickerEpochDay(date);
  switch (key) {
    case "ArrowLeft":
      return fromEpochDay(clampDay(day - 1));
    case "ArrowRight":
      return fromEpochDay(clampDay(day + 1));
    case "ArrowUp":
      return fromEpochDay(clampDay(day - 7));
    case "ArrowDown":
      return fromEpochDay(clampDay(day + 7));
    case "Home":
      return fromEpochDay(clampDay(day - (weekday(date) - 1)));
    case "End":
      return fromEpochDay(clampDay(day + (7 - weekday(date))));
    case "PageUp":
      return addMonthsClamped(date, shift ? -12 : -1);
    case "PageDown":
      return addMonthsClamped(date, shift ? 12 : 1);
  }
}

/**
 * False for a day before `min`, or one the shared `isCalendarDate` refuses (0099-12 cells
 * in the 0100-01 grid): it shows but can't be picked.
 */
export function isSelectable(date: CalendarDate, min?: CalendarDate): boolean {
  return isCalendarDate(date) && (!min || date >= min);
}

/** A typed `YYYY-MM-DD` naming a real day, or null for anything else. */
export function parseTyped(text: string): CalendarDate | null {
  const trimmed = text.trim();
  return isCalendarDate(trimmed) ? trimmed : null;
}

/** The day that takes focus on opening: the value, else today, and never before `min`. */
export function initialFocus(value: CalendarDate | "", today: CalendarDate, min?: CalendarDate): CalendarDate {
  const day = value && isCalendarDate(value) ? value : today;
  return min && isCalendarDate(min) && day < min ? min : day;
}

/** Today as the device sees it, as `YYYY-MM-DD` (the browser's local date). */
export function localToday(now: Date = new Date()): CalendarDate {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The date picker's grid and keyboard maths: pure functions over `YYYY-MM-DD` dates, no
 * DOM, so they are unit tested on their own (`tests/unit/date-picker-grid.test.ts`).
 */
import { type CalendarDate, fromEpochDay, isCalendarDate, isoWeekday, toEpochDay } from "@/domain/calendar-date";
import { addMonths, monthBounds, monthGridBounds, monthOf, type YearMonth } from "@/domain/calendar";

/** Six weeks, always, so the popup keeps its height from month to month. */
export const PICKER_DAYS = 42;

export type PickerDay = { date: CalendarDate; inMonth: boolean };

/** The 42 days the popup shows for `month`: Monday-first weeks from the week holding the 1st. */
export function pickerGrid(month: YearMonth): PickerDay[] {
  const start = toEpochDay(monthGridBounds(month).start);
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
  const last = monthBounds(month).last;
  const day = Math.min(Number(date.slice(8)), Number(last.slice(8)));
  return `${month}-${String(day).padStart(2, "0")}`;
}

/** Where focus goes from `date` on `key`. `shift` turns PageUp/PageDown into a year. */
export function moveFocus(date: CalendarDate, key: GridKey, shift = false): CalendarDate {
  const day = toEpochDay(date);
  switch (key) {
    case "ArrowLeft":
      return fromEpochDay(day - 1);
    case "ArrowRight":
      return fromEpochDay(day + 1);
    case "ArrowUp":
      return fromEpochDay(day - 7);
    case "ArrowDown":
      return fromEpochDay(day + 7);
    case "Home":
      return fromEpochDay(day - (isoWeekday(date) - 1));
    case "End":
      return fromEpochDay(day + (7 - isoWeekday(date)));
    case "PageUp":
      return addMonthsClamped(date, shift ? -12 : -1);
    case "PageDown":
      return addMonthsClamped(date, shift ? 12 : 1);
  }
}

/** False for a day before `min`: it shows, and takes focus, but can't be picked. */
export function isSelectable(date: CalendarDate, min?: CalendarDate): boolean {
  return !min || date >= min;
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

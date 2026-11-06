/**
 * Calendar views: months, the month grid, the agenda list and the team "who's out"
 * grouping. Pure functions over `YYYY-MM-DD` dates (see `calendar-date.ts`).
 */
import { type CalendarDate, eachDate, fromEpochDay, isoWeekday, toEpochDay } from "./calendar-date";
import { ACTIVE_STATUSES, type DayPortion, type LeaveStatus } from "./leave-request";

/** A calendar month as `YYYY-MM`. */
export type YearMonth = string;

const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** Months outside these years are refused, so links and queries stay sane. */
export const MIN_CALENDAR_YEAR = 1900;
export const MAX_CALENDAR_YEAR = 2999;

/** True for a well-formed `YYYY-MM` between {@link MIN_CALENDAR_YEAR} and {@link MAX_CALENDAR_YEAR}. */
export function isYearMonth(value: string): value is YearMonth {
  const m = YEAR_MONTH.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  return year >= MIN_CALENDAR_YEAR && year <= MAX_CALENDAR_YEAR;
}

/** The month a date falls in. */
export function monthOf(date: CalendarDate): YearMonth {
  return date.slice(0, 7);
}

/** The month `count` months after `month` (before, when negative). */
export function addMonths(month: YearMonth, count: number): YearMonth {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + count;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** First and last day of a month, inclusive. */
export function monthBounds(month: YearMonth): { first: CalendarDate; last: CalendarDate } {
  const first = `${month}-01`;
  const last = fromEpochDay(toEpochDay(`${addMonths(month, 1)}-01`) - 1);
  return { first, last };
}

/**
 * The dates a month grid shows: whole weeks, Monday to Sunday (ISO weeks, matching
 * the company's ISO working days), from the week holding the 1st to the week holding
 * the last day. Always 4 to 6 weeks.
 */
export function monthGridBounds(month: YearMonth): { start: CalendarDate; end: CalendarDate } {
  const { first, last } = monthBounds(month);
  const start = fromEpochDay(toEpochDay(first) - (isoWeekday(first) - 1));
  const end = fromEpochDay(toEpochDay(last) + (7 - isoWeekday(last)));
  return { start, end };
}

/**
 * One approved or pending leave request as calendars show it. Deliberately carries no
 * note, decision note or balance: every calendar view and feed is built from this
 * shape, so none of them can leak those.
 */
export interface CalendarEntry {
  id: string;
  userId: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  status: LeaveStatus;
  leaveTypeName: string;
  /** Short label, e.g. "PTO". */
  leaveTypeCode: string;
  leaveTypeColor: string;
  /** When the request last changed. */
  updatedAt: Date;
}

/** A calendar entry with the person it belongs to, for the team view and team feed. */
export interface TeamCalendarEntry extends CalendarEntry {
  personName: string;
  departmentName: string | null;
}

/**
 * An entry on the person's own calendar, which can also show colleagues' leave (the
 * calendar's filters): whose it is, and whether it is the viewer's own, which alone
 * opens its request.
 */
export interface CalendarViewEntry extends TeamCalendarEntry {
  isMine: boolean;
}

/** Only approved and pending leave appear on calendars; rejected and cancelled never do. */
export function isShownOnCalendar(status: LeaveStatus): boolean {
  return (ACTIVE_STATUSES as readonly LeaveStatus[]).includes(status);
}

export interface Holiday {
  date: CalendarDate;
  name: string;
}

export interface CalendarDay<E extends CalendarEntry = CalendarEntry> {
  date: CalendarDate;
  /** False for the leading and trailing days of the neighbouring months. */
  inMonth: boolean;
  isToday: boolean;
  /** A company working weekday (holidays aside). */
  isWorkingDay: boolean;
  /** The holiday's name, or `null`. */
  holiday: string | null;
  /**
   * Leave that costs this day: entries covering the date, on working days that are not
   * holidays only, since leave never counts on those. Ordered by start date.
   */
  entries: E[];
}

export interface MonthGridInput<E extends CalendarEntry = CalendarEntry> {
  month: YearMonth;
  today: CalendarDate;
  /** ISO weekdays that are working days (1 = Monday ... 7 = Sunday). */
  workingDays: readonly number[];
  holidays: readonly Holiday[];
  entries: readonly E[];
}

/** The month as weeks of seven {@link CalendarDay}s, Monday first. */
export function buildMonthGrid<E extends CalendarEntry>(input: MonthGridInput<E>): CalendarDay<E>[][] {
  const { start, end } = monthGridBounds(input.month);
  const working = new Set(input.workingDays);
  const holidays = new Map(input.holidays.map((h) => [h.date, h.name]));
  const entries = sortEntries(input.entries.filter((e) => isShownOnCalendar(e.status)));

  const days = eachDate(start, end).map((date): CalendarDay<E> => {
    const isWorkingDay = working.has(isoWeekday(date));
    const holiday = holidays.get(date) ?? null;
    const counts = costsLeave(date, working, holidays);
    return {
      date,
      inMonth: monthOf(date) === input.month,
      isToday: date === input.today,
      isWorkingDay,
      holiday,
      entries: counts ? entries.filter((e) => e.startDate <= date && e.endDate >= date) : [],
    };
  });
  const weeks: CalendarDay<E>[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

/** True when leave would cost `date`: a working weekday that is not a company holiday. */
function costsLeave(date: CalendarDate, working: ReadonlySet<number>, holidays: ReadonlyMap<CalendarDate, string>): boolean {
  return working.has(isoWeekday(date)) && !holidays.has(date);
}

/** A stretch of days and the company calendar that decides which of them cost leave. */
export interface CalendarRange {
  first: CalendarDate;
  last: CalendarDate;
  /** ISO weekdays that are working days (1 = Monday ... 7 = Sunday). */
  workingDays: readonly number[];
  /** Company holidays; only those between `first` and `last` matter. */
  holidays: readonly Holiday[];
}

/**
 * The shown entries (approved or pending) that cost at least one day from `first` to
 * `last`: a working day that is not a holiday, the rule the month grid draws by. A
 * Friday-to-Sunday request belongs to the Friday's month and not to the next one, even
 * though its weekend falls there.
 */
export function entriesCostingDaysIn<T extends CalendarEntry>(entries: readonly T[], range: CalendarRange): T[] {
  const working = new Set(range.workingDays);
  const holidays = new Map(range.holidays.map((h) => [h.date, h.name]));
  return entries.filter((e) => {
    if (!isShownOnCalendar(e.status) || e.startDate > range.last || e.endDate < range.first) return false;
    const from = e.startDate > range.first ? e.startDate : range.first;
    const to = e.endDate < range.last ? e.endDate : range.last;
    return eachDate(from, to).some((date) => costsLeave(date, working, holidays));
  });
}

export type AgendaItem<E extends CalendarEntry = CalendarEntry> =
  | { kind: "leave"; date: CalendarDate; entry: E }
  | { kind: "holiday"; date: CalendarDate; name: string };

/**
 * The month as a list for narrow screens: each request once (those that cost at least
 * one day of the month, so it agrees with the grid) and each holiday in the month, in
 * date order. A request that began in an earlier month sorts by its start date, so it
 * comes first.
 */
export function buildAgenda<E extends CalendarEntry>(
  input: Pick<MonthGridInput<E>, "month" | "workingDays" | "holidays" | "entries">,
): AgendaItem<E>[] {
  const { first, last } = monthBounds(input.month);
  const leave: AgendaItem<E>[] = sortEntries(
    entriesCostingDaysIn(input.entries, { first, last, workingDays: input.workingDays, holidays: input.holidays }),
  ).map((entry) => ({ kind: "leave", date: entry.startDate, entry }));
  const holidays: AgendaItem<E>[] = input.holidays
    .filter((h) => h.date >= first && h.date <= last)
    .map((h) => ({ kind: "holiday", date: h.date, name: h.name }));
  // Stable sort: on the same date, holidays come before leave.
  return [...holidays, ...leave].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface PersonOut {
  userId: string;
  personName: string;
  departmentName: string | null;
  entries: TeamCalendarEntry[];
}

/**
 * The team view's "who's out" list: one group per person with approved or pending
 * leave, people ordered by name (then id, for people who share one), each person's
 * leave by start date.
 */
export function groupByPerson(entries: readonly TeamCalendarEntry[]): PersonOut[] {
  const groups = new Map<string, PersonOut>();
  for (const entry of sortEntries(entries.filter((e) => isShownOnCalendar(e.status)))) {
    const group = groups.get(entry.userId);
    if (group) group.entries.push(entry);
    else groups.set(entry.userId, { userId: entry.userId, personName: entry.personName, departmentName: entry.departmentName, entries: [entry] });
  }
  return [...groups.values()].sort(
    (a, b) => a.personName.localeCompare(b.personName, "en", { sensitivity: "base" }) || a.userId.localeCompare(b.userId),
  );
}

/** Morning before afternoon on the same date; otherwise by start, then end, then id. */
const PORTION_ORDER: Record<DayPortion, number> = { am: 0, full: 1, pm: 2 };

function sortEntries<T extends CalendarEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      PORTION_ORDER[a.dayPortion] - PORTION_ORDER[b.dayPortion] ||
      a.endDate.localeCompare(b.endDate) ||
      a.id.localeCompare(b.id),
  );
}

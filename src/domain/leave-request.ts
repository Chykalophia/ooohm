import { type CalendarDate, fromEpochDay, isCalendarDate, spanInDays, toEpochDay } from "./calendar-date";
import { DomainError } from "./errors";

export const DAY_PORTIONS = ["full", "am", "pm"] as const;
/** Which part of a day a request covers. `am`/`pm` are half days and single-day only. */
export type DayPortion = (typeof DAY_PORTIONS)[number];

export const LEAVE_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** Statuses that hold the requester's time: they block overlapping requests. */
export const ACTIVE_STATUSES = ["pending", "approved"] as const satisfies readonly LeaveStatus[];

/** Longest free-text note or decision reason, in characters. */
export const NOTE_MAX_LENGTH = 500;

/**
 * Longest range a single request may cover, in calendar days. Keeps day counting
 * bounded and catches typos such as a year of 2062 instead of 2026.
 */
export const MAX_REQUEST_SPAN_DAYS = 366;

/**
 * The earliest start date a request covering `date` can have, given
 * {@link MAX_REQUEST_SPAN_DAYS}: lets range queries bound their scan from below.
 */
export function earliestOverlappingStart(date: CalendarDate): CalendarDate {
  return fromEpochDay(toEpochDay(date) - (MAX_REQUEST_SPAN_DAYS - 1));
}

/** The date part of a leave request: what is being asked for, before day counting. */
export interface LeaveRange {
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
}

/**
 * Checks the shape of a requested range.
 *
 * @throws DomainError `invalid_input` for malformed dates, `invalid_date_range` when
 *   end precedes start, `range_too_long` past {@link MAX_REQUEST_SPAN_DAYS}, and
 *   `half_day_multi_day` for an am/pm request spanning more than one day.
 */
export function assertValidRange(range: LeaveRange): void {
  if (!isCalendarDate(range.startDate) || !isCalendarDate(range.endDate)) {
    throw new DomainError("invalid_input", "Dates must be real calendar dates in YYYY-MM-DD form.");
  }
  if (!(DAY_PORTIONS as readonly string[]).includes(range.dayPortion)) {
    throw new DomainError("invalid_input", "Unknown day portion.");
  }
  if (range.endDate < range.startDate) throw new DomainError("invalid_date_range");
  if (spanInDays(range.startDate, range.endDate) > MAX_REQUEST_SPAN_DAYS) throw new DomainError("range_too_long");
  if (range.dayPortion !== "full" && range.startDate !== range.endDate) throw new DomainError("half_day_multi_day");
}

/**
 * Trims free text and turns blank into `null`.
 *
 * @throws DomainError `invalid_input` when longer than {@link NOTE_MAX_LENGTH}.
 */
export function normalizeNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > NOTE_MAX_LENGTH) {
    throw new DomainError("invalid_input", `Notes are limited to ${NOTE_MAX_LENGTH} characters.`, { field: "note" });
  }
  return trimmed === "" ? null : trimmed;
}

/**
 * Whether two ranges claim the same time. Ranges that share a date overlap, except a
 * morning and an afternoon half day on the same date, which together make one day.
 */
export function rangesOverlap(a: LeaveRange, b: LeaveRange): boolean {
  if (a.startDate > b.endDate || b.startDate > a.endDate) return false;
  const complementaryHalves = a.dayPortion !== "full" && b.dayPortion !== "full" && a.dayPortion !== b.dayPortion;
  // Half days are single-day, so two halves that intersect fall on the same date.
  return !complementaryHalves;
}

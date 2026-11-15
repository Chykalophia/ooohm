/**
 * A minimal iCalendar (RFC 5545) writer for published, read-only calendars of
 * all-day events: what OOOhm's calendar feeds need, and nothing else.
 *
 * Output uses CRLF line endings and folds every content line at 75 octets of UTF-8
 * without splitting a character, so Google Calendar, Apple Calendar and Outlook all
 * accept it. Text values are escaped here; callers pass plain strings.
 */
import { type CalendarDate, fromEpochDay, isCalendarDate, toEpochDay } from "./calendar-date";

const CRLF = "\r\n";
/** RFC 5545 §3.1: lines SHOULD NOT be longer than 75 octets, excluding the line break. */
export const ICS_MAX_LINE_OCTETS = 75;

/** One all-day event. `endDate` is the last day off, inclusive, as stored. */
export interface IcsEvent {
  /** Globally unique and stable across refreshes, e.g. `<request id>@ooohm`. */
  uid: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  summary: string;
  /** `TENTATIVE` for leave still waiting for approval. */
  status: "CONFIRMED" | "TENTATIVE";
  /**
   * `TRANSPARENT` when the event should not mark the subscriber busy (someone else's
   * leave); `OPAQUE` when it should (your own).
   */
  transparency: "OPAQUE" | "TRANSPARENT";
  /** When the event last changed; clients use it to notice updates. */
  lastModified?: Date;
}

export interface IcsCalendar {
  /** Shown as the calendar's name (`X-WR-CALNAME` and RFC 7986 `NAME`). */
  name: string;
  /** How often clients should refetch, as an ISO 8601 duration, e.g. `PT1H`. */
  refreshInterval: string;
  /** `DTSTAMP` of every event: when this copy of the calendar was produced. */
  generatedAt: Date;
  events: readonly IcsEvent[];
}

export const ICS_PRODID = "-//OOOhm//Calendar feed 1.0//EN";

/**
 * Escapes a TEXT value (RFC 5545 §3.3.11): backslash, semicolon and comma get a
 * backslash, and every line break (CRLF, CR or LF) becomes the two characters `\n`.
 * Other control characters are not allowed in TEXT and are dropped.
 */
export function escapeIcsText(value: string): string {
  return (
    value
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n")
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
  );
}

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Folds one content line (RFC 5545 §3.1) so no physical line exceeds
 * {@link ICS_MAX_LINE_OCTETS} octets of UTF-8. Continuation lines start with one
 * space, which counts toward their length. Splits only between code points, so a
 * multibyte character is never cut in half. Returns the physical lines joined by
 * CRLF, without a trailing line break.
 */
export function foldIcsLine(line: string): string {
  if (utf8Length(line) <= ICS_MAX_LINE_OCTETS) return line;
  const lines: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = utf8Length(char);
    if (octets + size > ICS_MAX_LINE_OCTETS) {
      lines.push(current);
      current = " ";
      octets = 1;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines.join(CRLF);
}

/** `YYYYMMDD`, the DATE value form. */
export function icsDate(date: CalendarDate): string {
  return date.replaceAll("-", "");
}

/** `YYYYMMDDTHHMMSSZ`, a DATE-TIME in UTC. */
export function icsDateTime(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * The exclusive `DTEND` of an all-day event that ends on `lastDay`: the next day
 * (RFC 5545 §3.6.1), so a one-day event on Nov 2 runs from 20261102 to 20261103.
 */
export function exclusiveEndDate(lastDay: CalendarDate): CalendarDate {
  return fromEpochDay(toEpochDay(lastDay) + 1);
}

function eventLines(event: IcsEvent, stamp: string): string[] {
  if (!isCalendarDate(event.startDate) || !isCalendarDate(event.endDate) || event.endDate < event.startDate) {
    throw new RangeError(`Invalid event dates for ${event.uid}`);
  }
  return [
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${icsDate(event.startDate)}`,
    `DTEND;VALUE=DATE:${icsDate(exclusiveEndDate(event.endDate))}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    `STATUS:${event.status}`,
    `TRANSP:${event.transparency}`,
    ...(event.lastModified ? [`LAST-MODIFIED:${icsDateTime(event.lastModified)}`] : []),
    "END:VEVENT",
  ];
}

/**
 * Serializes a published calendar (`METHOD:PUBLISH`) of all-day events.
 *
 * @returns The whole document, every line folded and ended with CRLF.
 * @throws RangeError when an event's dates are not real dates or end before they start.
 */
export function serializeCalendar(calendar: IcsCalendar): string {
  const stamp = icsDateTime(calendar.generatedAt);
  const name = escapeIcsText(calendar.name);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${name}`,
    `NAME:${name}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${calendar.refreshInterval}`,
    `X-PUBLISHED-TTL:${calendar.refreshInterval}`,
    ...calendar.events.flatMap((event) => eventLines(event, stamp)),
    "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}

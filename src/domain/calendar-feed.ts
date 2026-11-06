/**
 * Calendar feeds: what a subscribed calendar (Google, Apple, Outlook) shows.
 *
 * A personal feed holds one person's own leave; a team feed holds everyone's in the
 * company. Both carry approved leave and pending leave (marked tentative and
 * "pending" in the title), and never a note, a decision note or a balance: entries
 * are {@link CalendarEntry}s, which carry none of them.
 */
import type { CalendarEntry, TeamCalendarEntry } from "./calendar";
import { type CalendarDate, fromEpochDay, toEpochDay } from "./calendar-date";
import type { IcsCalendar, IcsEvent } from "./ics";

export const FEED_KINDS = ["personal", "team"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export function isFeedKind(value: unknown): value is FeedKind {
  return typeof value === "string" && (FEED_KINDS as readonly string[]).includes(value);
}

/** How far back a feed reaches, in days before today. */
export const FEED_DAYS_BACK = 90;
/** How far ahead a feed reaches, in days after today: about 18 months. */
export const FEED_DAYS_AHEAD = 548;
/** How often subscribers are asked to refetch. Google ignores it and refreshes on its own schedule. */
export const FEED_REFRESH_INTERVAL = "PT1H";

/** The dates a feed covers, inclusive, around `today` in the company's time zone. */
export function feedWindow(today: CalendarDate): { from: CalendarDate; to: CalendarDate } {
  const day = toEpochDay(today);
  return { from: fromEpochDay(day - FEED_DAYS_BACK), to: fromEpochDay(day + FEED_DAYS_AHEAD) };
}

const PORTION_TAG = { am: "AM", pm: "PM" } as const;

/**
 * An event title: "PTO" in a personal feed, "Ana: PTO" in a team feed, with "(AM)",
 * "(PM)", "(pending)" or "(AM, pending)" added as they apply.
 */
export function feedEventSummary(entry: Pick<CalendarEntry, "leaveTypeCode" | "dayPortion" | "status">, personName?: string): string {
  const tags: string[] = [];
  if (entry.dayPortion !== "full") tags.push(PORTION_TAG[entry.dayPortion]);
  if (entry.status === "pending") tags.push("pending");
  const label = personName ? `${personName}: ${entry.leaveTypeCode}` : entry.leaveTypeCode;
  return tags.length > 0 ? `${label} (${tags.join(", ")})` : label;
}

/** The event's UID: the request id, stable for the request's whole life. */
export function feedEventUid(requestId: string): string {
  return `${requestId}@ooohm`;
}

function toEvent(entry: CalendarEntry, summary: string, transparency: IcsEvent["transparency"]): IcsEvent {
  return {
    uid: feedEventUid(entry.id),
    startDate: entry.startDate,
    endDate: entry.endDate,
    summary,
    status: entry.status === "pending" ? "TENTATIVE" : "CONFIRMED",
    transparency,
    lastModified: entry.updatedAt,
  };
}

/** What one feed renders: the calendar's name and its entries. */
export type FeedContent =
  | { kind: "personal"; calendarName: string; entries: readonly CalendarEntry[] }
  | { kind: "team"; calendarName: string; entries: readonly TeamCalendarEntry[] };

/**
 * The calendar a feed serves. Your own leave marks you busy; other people's leave in
 * the team feed does not.
 */
export function buildFeedCalendar(content: FeedContent, generatedAt: Date): IcsCalendar {
  const events =
    content.kind === "personal"
      ? content.entries.map((e) => toEvent(e, feedEventSummary(e), "OPAQUE"))
      : content.entries.map((e) => toEvent(e, feedEventSummary(e, e.personName), "TRANSPARENT"));
  return { name: content.calendarName, refreshInterval: FEED_REFRESH_INTERVAL, generatedAt, events };
}

/** The calendar name subscribers see, e.g. "OOOhm: Who's out at Acme". */
export function feedCalendarName(kind: FeedKind, companyName: string): string {
  return kind === "personal" ? "OOOhm: My time off" : `OOOhm: Who's out at ${companyName}`;
}

/** One-tap ways to subscribe to a feed, so a new link never has to be copied by hand. */
export interface AddToCalendarLinks {
  google: string;
  /** `webcal://`: Apple Calendar on Mac, iPhone and iPad, and most other desktop apps. */
  apple: string;
  /** Outlook on the web (Microsoft 365). */
  outlook: string;
}

/**
 * The subscribe links for a feed's `url` (`https://…/api/ics/<token>.ics`). Each one
 * carries the secret link to that calendar service, which is what subscribing does anyway.
 */
export function addToCalendarLinks(url: string, name: string): AddToCalendarLinks {
  const webcal = url.replace(/^https?:\/\//, "webcal://");
  return {
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    apple: webcal,
    outlook: `https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`,
  };
}

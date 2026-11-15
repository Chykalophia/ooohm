import "server-only";
import type { TeamCalendarEntry } from "@/shared/kernel/calendar";
import type { FeedKind } from "@/shared/kernel/calendar-feed";
import { teamLabel } from "@/shared/kernel/person-label";

/** A team row as the calendar repository reads it: the entry, plus the email its label falls back on. */
export type TeamEntrySource = TeamCalendarEntry & { personEmail: string };

/**
 * A team row as a calendar entry, labelled by {@link teamLabel}: the name, or the
 * email's local part when the name is blank, never the full address.
 */
export function toTeamEntry({ personEmail, ...row }: TeamEntrySource): TeamCalendarEntry {
  return { ...row, personName: teamLabel({ name: row.personName, email: personEmail }) };
}

/** One day of a company holiday, with its id. */
export interface CalendarHolidayDTO {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  name: string;
}

export function toCalendarHolidayDTO({ id, date, name }: CalendarHolidayDTO): CalendarHolidayDTO {
  return { id, date, name };
}

/** A live feed as its owner sees it. The link itself is never shown again after issue. */
export interface FeedSummary {
  createdAt: Date;
  lastUsedAt: Date | null;
  /** The link's last 4 characters, to tell it apart in a calendar app; null for older links. */
  hint: string | null;
}

/** A feed as its owner sees it: never its id, kind, owner or token hash. */
export function toFeedSummary(feed: { createdAt: Date; lastUsedAt: Date | null; tokenHint: string | null }): FeedSummary {
  return { createdAt: feed.createdAt, lastUsedAt: feed.lastUsedAt, hint: feed.tokenHint };
}

/** A rendered feed: the iCalendar document and which feed it was, for logs. */
export interface RenderedFeed {
  feedId: string;
  kind: FeedKind;
  body: string;
}

/** A newly issued feed link: the token and its full URL, shown once. */
export interface IssuedFeedDTO {
  token: string;
  url: string;
  feed: FeedSummary;
}

/** The actor's live feeds by kind (`null` for a kind with no live link), and the time zone to show their dates in. */
export interface CalendarFeedsDTO {
  timezone: string;
  feeds: Record<FeedKind, FeedSummary | null>;
}

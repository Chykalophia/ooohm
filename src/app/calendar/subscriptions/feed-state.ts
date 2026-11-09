import type { AddToCalendarLinks } from "@/domain/calendar-feed";

/**
 * Result of the feed card's server action. `issued` carries the new link, the only
 * time it is ever shown, and the one-tap ways to subscribe to it.
 */
export type FeedState =
  | { status: "idle" }
  | { status: "issued"; url: string; links: AddToCalendarLinks }
  | { status: "off" }
  | { status: "error"; message: string };

export const FEED_IDLE: FeedState = { status: "idle" };

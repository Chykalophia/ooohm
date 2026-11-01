/**
 * Result of the feed card's server action. `issued` carries the new link, the only
 * time it is ever shown.
 */
export type FeedState =
  | { status: "idle" }
  | { status: "issued"; url: string }
  | { status: "off" }
  | { status: "error"; message: string };

export const FEED_IDLE: FeedState = { status: "idle" };

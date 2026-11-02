import { isDomainError } from "@/domain/errors";
import { feedLogId, tokenFromFeedFileName } from "@/lib/feed-token";
import { log } from "@/lib/log";
import type { RateLimiter } from "@/lib/rate-limit";
import type { ServiceContext } from "@/server/context";
import { renderCalendarFeed } from "@/server/services/calendar-feeds";

/** The two limits on the public feed route. */
export interface FeedLimits {
  /**
   * Fetches that found no live link, per client address. Only a miss spends or checks
   * it, after the lookup, so it can never refuse a live link: real calendar apps share
   * addresses (Google fetches every subscriber's feed from a few), and the key may be the
   * one shared bucket (see `clientAddress`) that anyone can fill.
   */
  misses: RateLimiter;
  /** Fetches per live link, keyed by the feed's id: only real links occupy it. */
  perFeed: RateLimiter;
}

export const MISSES_PER_MINUTE = 60;
export const FETCHES_PER_FEED_PER_MINUTE = 30;
export const RETRY_AFTER_SECONDS = "60";

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

const tooMany = () => plain(429, "Too many requests", { "Retry-After": RETRY_AFTER_SECONDS });

/**
 * Answers one feed fetch: the body of `GET /api/ics/<token>.ics`, with its
 * dependencies injected so it can be tested without Next.
 *
 * A malformed file name gets a bare 404 before anything else runs. An unknown or
 * revoked token, or one whose owner was deactivated or left the company, gets the same
 * bare 404, so a response never says which, until the client has spent its miss budget
 * for the window; further misses get 429. A live link is served whatever the miss
 * budget says, and gets 429 only when that link itself is fetched too often. The token
 * is never logged; log lines carry a short prefix of its hash.
 *
 * @param input.client The caller's address, from `clientAddress`.
 */
export async function handleFeedFetch(input: { ctx: ServiceContext; file: string; client: string; limits: FeedLimits }): Promise<Response> {
  const { ctx, file, client, limits } = input;
  const token = tokenFromFeedFileName(file);
  if (!token) return plain(404, "Not found");

  try {
    const feed = await renderCalendarFeed(ctx, token, { admit: (feedId) => limits.perFeed.take(feedId) });
    if (!feed) return limits.misses.take(client) ? plain(404, "Not found") : tooMany();
    return new Response(feed.body, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "private, max-age=300",
        // The URL is the secret; keep it out of any Referer this response leads to.
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (isDomainError(err) && err.code === "rate_limited") return tooMany();
    log.error({ err, feed: feedLogId(token) }, "calendar_feed_failed");
    return plain(500, "The calendar isn't available right now.");
  }
}

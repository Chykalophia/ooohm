import type { NextRequest } from "next/server";
import { clientAddress } from "@/lib/client-address";
import { env } from "@/lib/env";
import { createRateLimiter } from "@/lib/rate-limit";
import { serviceContext } from "@/server/runtime";
import { FETCHES_PER_FEED_PER_MINUTE, type FeedLimits, handleFeedFetch, MISSES_PER_MINUTE } from "./feed-fetch";

/**
 * Per-process limits. Calendar apps poll every few minutes at most, so these only stop
 * a runaway client, or someone guessing links, from turning the feed into database
 * load. Both are bounded in memory (see `createRateLimiter`).
 */
const limits: FeedLimits = {
  misses: createRateLimiter({ limit: MISSES_PER_MINUTE, windowMs: 60_000 }),
  perFeed: createRateLimiter({ limit: FETCHES_PER_FEED_PER_MINUTE, windowMs: 60_000 }),
};

/**
 * ICS feed: `GET /api/ics/<token>.ics`, for calendar apps (Google, Apple, Outlook).
 *
 * Needs no session, since calendar apps cannot sign in: the 256-bit token in the URL is
 * the credential. See {@link handleFeedFetch} for the responses. Responses may be
 * cached privately for 5 minutes and never by shared caches.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  return handleFeedFetch({ ctx: serviceContext(), file: (await params).file, client: clientAddress(request.headers, env.TRUSTED_PROXY_HOPS), limits });
}

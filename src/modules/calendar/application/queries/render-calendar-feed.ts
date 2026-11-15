import "server-only";
import { buildFeedCalendar, type FeedContent, feedCalendarName, feedWindow } from "@/domain/calendar-feed";
import { serializeCalendar } from "@/domain/ics";
import { todayInTimeZone } from "@/lib/dates";
import { isFeedTokenShape } from "@/lib/feed-token";
import { hashToken } from "@/lib/token-hash";
import type { ServiceContext } from "@/server/context";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import { listPersonalEntries, listTeamEntries } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";
import { findLiveFeedByHash, touchFeed } from "@/modules/calendar/infrastructure/drizzle-calendar-feeds.repository";
import { scopeOf } from "@/modules/calendar/application/calendar-scope";
import { type RenderedFeed, toTeamEntry } from "@/modules/calendar/application/dto";

/** How often a feed's `last_used_at` is rewritten at most. */
const TOUCH_INTERVAL_MS = 3_600_000;

/**
 * Renders the feed a token opens, for calendar apps, which cannot sign in: the token
 * is the only credential.
 *
 * Returns `null`, with no hint why, for a malformed, unknown or revoked token, or one
 * whose owner is inactive or has left the company, so deactivating someone stops
 * their feeds at once. Covers {@link feedWindow} around today in the company's time
 * zone. The team feed follows the team view's privacy rule: who, when and which leave
 * type only, never a note; and only the people its owner may see now
 * (`calendarScopeFor`), so a change of setting, role or manager reaches it at once.
 *
 * Two queries, or three when the `last_used_at` stamp is missing or over an hour old:
 * the token lookup, then the entries and the stamp in parallel; under department
 * scoping, one more before the entries, for the departments the owner manages.
 *
 * @param options.admit Asked with the feed's id once the token is known to be live,
 *   before the entries are read; returning `false` stops there with `rate_limited`. The
 *   route uses it to rate-limit each link by its id, which only live links have, so
 *   made-up tokens cannot grow the limiter.
 */
export async function renderCalendarFeed(
  ctx: ServiceContext,
  token: string,
  options: { admit?: (feedId: string) => boolean } = {},
): Promise<ServiceResult<RenderedFeed | null>> {
  if (!isFeedTokenShape(token)) return ok(null);
  const feed = await findLiveFeedByHash(ctx.db, hashToken(token));
  if (!feed) return ok(null);
  if (options.admit && !options.admit(feed.id)) return err("rate_limited");

  const now = ctx.now();
  const staleBefore = new Date(now.getTime() - TOUCH_INTERVAL_MS);
  const stale = feed.lastUsedAt === null || feed.lastUsedAt < staleBefore;
  const { from, to } = feedWindow(todayInTimeZone(feed.timezone, now));
  const calendarName = feedCalendarName(feed.kind, feed.companyName);
  const [content] = await Promise.all([
    feed.kind === "personal"
      ? listPersonalEntries(ctx.db, feed.companyId, feed.userId, from, to).then(
          (entries): FeedContent => ({ kind: "personal", calendarName, entries }),
        )
      : scopeOf(ctx.db, feed.companyId, { id: feed.userId, role: feed.ownerRole, managerId: feed.ownerManagerId, departmentId: feed.ownerDepartmentId }, feed)
          .then((scope) => listTeamEntries(ctx.db, feed.companyId, from, to, { scope }))
          .then((rows): FeedContent => ({ kind: "team", calendarName, entries: rows.map(toTeamEntry) })),
    stale ? touchFeed(ctx.db, feed.id, now, staleBefore) : undefined,
  ]);
  return ok({ feedId: feed.id, kind: feed.kind, body: serializeCalendar(buildFeedCalendar(content, now)) });
}

import type { Actor } from "@/domain/actor";
import { buildFeedCalendar, type FeedContent, feedCalendarName, type FeedKind, feedWindow, isFeedKind } from "@/domain/calendar-feed";
import type { PersonChangeSource } from "@/domain/change-source";
import { DomainError } from "@/domain/errors";
import {
  CALENDAR_FEED_EVENT_TYPES,
  type CalendarFeedEventPayload,
  type CalendarFeedRevokeReason,
  calendarFeedAuditAction,
  type Unattributed,
} from "@/domain/events";
import { serializeCalendar } from "@/domain/ics";
import { todayInTimeZone } from "@/lib/dates";
import { feedPath, generateFeedToken, hashFeedToken, isFeedTokenShape } from "@/lib/feed-token";
import type { ServiceContext } from "@/server/context";
import type { Transaction } from "@/db/types";
import { findCompanySettings, listPersonalEntries, listTeamEntries } from "@/server/repositories/calendar";
import {
  type CalendarFeedRow,
  findLiveFeedByHash,
  insertFeed,
  listLiveFeeds,
  revokeAllLiveFeeds,
  revokeLiveFeed,
  touchFeed,
} from "@/server/repositories/calendar-feeds";
import { recordChange } from "@/server/repositories/change-log";
import { lockMember } from "@/server/repositories/users";
import { toTeamEntry } from "./calendar";

/** A live feed as its owner sees it. The link itself is never shown again after issue. */
export interface FeedSummary {
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** The audited view of a feed: never its hash, which would be a step towards the link. */
function snapshot(row: CalendarFeedRow) {
  return { kind: row.kind, createdAt: row.createdAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null };
}

async function recordFeedChange(
  tx: Transaction,
  change: { event: "issued" | "revoked"; before: CalendarFeedRow | null; after: CalendarFeedRow; source: PersonChangeSource; reason: CalendarFeedRevokeReason | null },
): Promise<void> {
  const { after, source } = change;
  const payload: Unattributed<CalendarFeedEventPayload> = { feedId: after.id, userId: after.userId, kind: after.kind, reason: change.reason };
  await recordChange(tx, {
    source,
    audit: {
      companyId: after.companyId,
      action: calendarFeedAuditAction(change.event),
      entityType: "calendar_feed",
      entityId: after.id,
      subjectUserId: after.userId,
      before: change.before ? snapshot(change.before) : null,
      after: snapshot(after),
    },
    event: { companyId: after.companyId, type: CALENDAR_FEED_EVENT_TYPES[change.event], payload },
  });
}

/**
 * The actor's live feeds by kind (`null` for a kind with no live link), and the
 * company's time zone for showing their dates. Includes a link issued in a company the
 * actor has since left: it answers 404 while they are elsewhere, but would work again
 * if they moved back, so they must be able to see it and turn it off.
 *
 * @throws DomainError `no_company` when the actor's company is missing.
 */
export async function listCalendarFeeds(
  ctx: ServiceContext,
  actor: Actor,
): Promise<{ timezone: string; feeds: Record<FeedKind, FeedSummary | null> }> {
  const [settings, rows] = await Promise.all([
    findCompanySettings(ctx.db, actor.companyId),
    listLiveFeeds(ctx.db, actor.id),
  ]);
  if (!settings) throw new DomainError("no_company");
  const summary = (kind: FeedKind) => {
    const row = rows.find((r) => r.kind === kind);
    return row ? { createdAt: row.createdAt, lastUsedAt: row.lastUsedAt } : null;
  };
  return { timezone: settings.timezone, feeds: { personal: summary("personal"), team: summary("team") } };
}

/** Runs `work` for the actor under their member lock, refusing an inactive member. */
async function asMember<T>(ctx: ServiceContext, actor: Actor, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    // Serialises one person's feed changes, so two clicks at once cannot leave two live links.
    const member = await lockMember(tx, actor.companyId, actor.id);
    if (!member?.isActive) throw new DomainError("forbidden");
    return work(tx);
  });
}

/**
 * Issues a new feed link of `kind` for the actor. A live link of the same kind is
 * revoked in the same transaction, so this is also "regenerate": the old URL stops
 * working the moment the new one exists. That includes a live link issued while the
 * person was in another company; its revoke is recorded under that company.
 *
 * Only the token's SHA-256 is stored. Every revoke and the issue write `audit_log` and
 * `events_outbox` rows (`calendar_feed.revoked` with reason `regenerated`, then
 * `calendar_feed.issued`) in the same transaction; neither carries the token.
 *
 * @returns The token and its full URL. This is the only time either exists outside
 *   the caller's hands; show it once.
 * @throws DomainError `invalid_input` (unknown kind) or `forbidden` (inactive member).
 */
export async function issueCalendarFeed(ctx: ServiceContext, actor: Actor, kind: FeedKind): Promise<{ token: string; url: string; feed: FeedSummary }> {
  if (!isFeedKind(kind)) throw new DomainError("invalid_input");
  return asMember(ctx, actor, async (tx) => {
    const now = ctx.now();
    const old = await revokeLiveFeed(tx, { userId: actor.id, kind }, now);
    if (old) {
      await recordFeedChange(tx, { event: "revoked", before: { ...old, revokedAt: null }, after: old, source: actor.source, reason: "regenerated" });
    }
    const token = generateFeedToken();
    const row = await insertFeed(tx, { companyId: actor.companyId, userId: actor.id, kind, tokenHash: hashFeedToken(token), createdAt: now });
    await recordFeedChange(tx, { event: "issued", before: null, after: row, source: actor.source, reason: null });
    return { token, url: `${ctx.appUrl}${feedPath(token)}`, feed: { createdAt: row.createdAt, lastUsedAt: null } };
  });
}

/**
 * Turns off the actor's live feed of `kind`: its link answers 404 from now on.
 *
 * @returns `false` when there was no live link (nothing changes or is recorded).
 * @throws DomainError `invalid_input` (unknown kind) or `forbidden` (inactive member).
 */
export async function revokeCalendarFeed(ctx: ServiceContext, actor: Actor, kind: FeedKind): Promise<boolean> {
  if (!isFeedKind(kind)) throw new DomainError("invalid_input");
  return asMember(ctx, actor, async (tx) => {
    const old = await revokeLiveFeed(tx, { userId: actor.id, kind }, ctx.now());
    if (!old) return false;
    await recordFeedChange(tx, { event: "revoked", before: { ...old, revokedAt: null }, after: old, source: actor.source, reason: "turned_off" });
    return true;
  });
}

/**
 * Turns off every live feed link of a person being deactivated, inside the caller's
 * transaction (which holds their member lock). Each revoke writes `audit_log` and a
 * `calendar_feed.revoked` event with reason `deactivated` and the admin as actor.
 *
 * @returns How many links were turned off.
 */
export async function revokeFeedsOnDeactivation(tx: Transaction, userId: string, admin: PersonChangeSource, at: Date): Promise<number> {
  const revoked = await revokeAllLiveFeeds(tx, userId, at);
  for (const row of revoked) {
    await recordFeedChange(tx, { event: "revoked", before: { ...row, revokedAt: null }, after: row, source: admin, reason: "deactivated" });
  }
  return revoked.length;
}

/** How often a feed's `last_used_at` is rewritten at most. */
const TOUCH_INTERVAL_MS = 3_600_000;

/** A rendered feed: the iCalendar document and which feed it was, for logs. */
export interface RenderedFeed {
  feedId: string;
  kind: FeedKind;
  body: string;
}

/**
 * Renders the feed a token opens, for calendar apps, which cannot sign in: the token
 * is the only credential.
 *
 * Returns `null`, with no hint why, for a malformed, unknown or revoked token, or one
 * whose owner is inactive or has left the company, so deactivating someone stops
 * their feeds at once. Covers {@link feedWindow} around today in the company's time
 * zone. The team feed follows the team view's privacy rule: who, when and which leave
 * type only, never a note.
 *
 * Two queries, or three when the `last_used_at` stamp is missing or over an hour old:
 * the token lookup, then the entries and the stamp in parallel.
 *
 * @param options.admit Asked with the feed's id once the token is known to be live,
 *   before the entries are read; returning `false` stops there. The route uses it to
 *   rate-limit each link by its id, which only live links have, so made-up tokens
 *   cannot grow the limiter.
 * @throws DomainError `rate_limited` when `admit` refuses.
 */
export async function renderCalendarFeed(
  ctx: ServiceContext,
  token: string,
  options: { admit?: (feedId: string) => boolean } = {},
): Promise<RenderedFeed | null> {
  if (!isFeedTokenShape(token)) return null;
  const feed = await findLiveFeedByHash(ctx.db, hashFeedToken(token));
  if (!feed) return null;
  if (options.admit && !options.admit(feed.id)) throw new DomainError("rate_limited");

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
      : listTeamEntries(ctx.db, feed.companyId, from, to).then(
          (rows): FeedContent => ({ kind: "team", calendarName, entries: rows.map(toTeamEntry) }),
        ),
    stale ? touchFeed(ctx.db, feed.id, now, staleBefore) : undefined,
  ]);
  return { feedId: feed.id, kind: feed.kind, body: serializeCalendar(buildFeedCalendar(content, now)) };
}

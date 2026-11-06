import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { calendarFeedTokens, companies, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { FeedKind } from "@/domain/calendar-feed";

export type CalendarFeedRow = typeof calendarFeedTokens.$inferSelect;

/**
 * The live feed a token hash names, with what rendering it needs, or `undefined` when
 * the hash is unknown, the link was revoked, or its owner is inactive or no longer in
 * the feed's company. One lookup on the unique `token_hash` index.
 */
export async function findLiveFeedByHash(ex: Executor, tokenHash: string) {
  const [row] = await ex
    .select({
      id: calendarFeedTokens.id,
      userId: calendarFeedTokens.userId,
      companyId: calendarFeedTokens.companyId,
      kind: calendarFeedTokens.kind,
      lastUsedAt: calendarFeedTokens.lastUsedAt,
      companyName: companies.name,
      timezone: companies.timezone,
    })
    .from(calendarFeedTokens)
    .innerJoin(user, eq(user.id, calendarFeedTokens.userId))
    .innerJoin(companies, eq(companies.id, calendarFeedTokens.companyId))
    .where(
      and(
        eq(calendarFeedTokens.tokenHash, tokenHash),
        isNull(calendarFeedTokens.revokedAt),
        eq(user.isActive, true),
        eq(user.companyId, calendarFeedTokens.companyId),
      ),
    );
  return row;
}

/**
 * Stamps the feed as fetched `at`, unless its stamp is already at or after
 * `staleBefore`. The service decides when a stamp is stale and calls this only then;
 * the same condition here keeps two concurrent fetches from both writing.
 */
export async function touchFeed(ex: Executor, id: string, at: Date, staleBefore: Date): Promise<void> {
  await ex
    .update(calendarFeedTokens)
    .set({ lastUsedAt: at })
    .where(
      and(
        eq(calendarFeedTokens.id, id),
        or(isNull(calendarFeedTokens.lastUsedAt), lt(calendarFeedTokens.lastUsedAt, staleBefore)),
      ),
    );
}

/**
 * A person's live feeds, without their hashes, whichever company each was issued in.
 * At most one per kind (`calendar_feed_tokens_live_uq`). A feed from a company the
 * person has since left is listed too, so they can still see and turn off a link that
 * would work again if they moved back.
 */
export async function listLiveFeeds(ex: Executor, userId: string) {
  return ex
    .select({
      id: calendarFeedTokens.id,
      kind: calendarFeedTokens.kind,
      createdAt: calendarFeedTokens.createdAt,
      lastUsedAt: calendarFeedTokens.lastUsedAt,
      tokenHint: calendarFeedTokens.tokenHint,
    })
    .from(calendarFeedTokens)
    .where(
      and(eq(calendarFeedTokens.userId, userId), isNull(calendarFeedTokens.revokedAt)),
    )
    .orderBy(asc(calendarFeedTokens.createdAt));
}

/** Whether the person has a live feed issued in this company (one a feed reader can use now). */
export async function hasLiveFeedIn(ex: Executor, companyId: string, userId: string): Promise<boolean> {
  const [row] = await ex
    .select({ id: calendarFeedTokens.id })
    .from(calendarFeedTokens)
    .where(and(eq(calendarFeedTokens.companyId, companyId), eq(calendarFeedTokens.userId, userId), isNull(calendarFeedTokens.revokedAt)))
    .limit(1);
  return row !== undefined;
}

/**
 * Revokes the person's live feed of `kind`, if any, and returns it after the change.
 * Matches by person and kind only, like the live-feed unique index, so a link issued
 * in a company the person has since left is revoked too.
 */
export async function revokeLiveFeed(
  tx: Transaction,
  where: { userId: string; kind: FeedKind },
  at: Date,
): Promise<CalendarFeedRow | undefined> {
  const [row] = await tx
    .update(calendarFeedTokens)
    .set({ revokedAt: at })
    .where(
      and(eq(calendarFeedTokens.userId, where.userId), eq(calendarFeedTokens.kind, where.kind), isNull(calendarFeedTokens.revokedAt)),
    )
    .returning();
  return row;
}

/** Revokes every live feed of the person, of any kind, and returns them after the change. */
export async function revokeAllLiveFeeds(tx: Transaction, userId: string, at: Date): Promise<CalendarFeedRow[]> {
  return tx
    .update(calendarFeedTokens)
    .set({ revokedAt: at })
    .where(and(eq(calendarFeedTokens.userId, userId), isNull(calendarFeedTokens.revokedAt)))
    .returning();
}

export async function insertFeed(
  tx: Transaction,
  values: { companyId: string; userId: string; kind: FeedKind; tokenHash: string; tokenHint: string; createdAt: Date },
): Promise<CalendarFeedRow> {
  const [row] = await tx.insert(calendarFeedTokens).values(values).returning();
  return row;
}

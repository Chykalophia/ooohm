import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { type FeedKind, isFeedKind } from "@/shared/kernel/calendar-feed";
import { feedPath, feedTokenHint, generateFeedToken } from "@/lib/feed-token";
import { hashToken } from "@/lib/token-hash";
import type { ServiceContext } from "@/server/context";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { insertFeed, revokeLiveFeed } from "@/modules/calendar/infrastructure/drizzle-calendar-feeds.repository";
import type { IssuedFeedDTO } from "@/modules/calendar/application/dto";
import { asMember, recordFeedChange } from "@/modules/calendar/application/feed-changes";

/**
 * Issues a new feed link of `kind` for the actor. A live link of the same kind is
 * revoked in the same transaction, so this is also "regenerate": the old URL stops
 * working the moment the new one exists. That includes a live link issued while the
 * person was in another company; its revoke is recorded under that company.
 *
 * Only the token's SHA-256 and its last 4 characters (the hint) are stored. Every revoke and the issue write `audit_log` and
 * `events_outbox` rows (`calendar_feed.revoked` with reason `regenerated`, then
 * `calendar_feed.issued`) in the same transaction; neither carries the token.
 *
 * @returns The token and its full URL. This is the only time either exists outside
 *   the caller's hands; show it once. Fails with `invalid_input` (unknown kind) or
 *   `forbidden` (inactive member).
 */
export async function issueCalendarFeed(ctx: ServiceContext, actor: Actor, kind: FeedKind): Promise<ServiceResult<IssuedFeedDTO>> {
  if (!isFeedKind(kind)) return err("invalid_input");
  return attempt(() =>
    asMember(ctx, actor, async (tx) => {
      const now = ctx.now();
      const old = await revokeLiveFeed(tx, { userId: actor.id, kind }, now);
      if (old) {
        await recordFeedChange(tx, actor.companyId, { event: "revoked", before: { ...old, revokedAt: null }, after: old, source: actor.source, reason: "regenerated" });
      }
      const token = generateFeedToken();
      const tokenHint = feedTokenHint(token);
      const row = await insertFeed(tx, { companyId: actor.companyId, userId: actor.id, kind, tokenHash: hashToken(token), tokenHint, createdAt: now });
      await recordFeedChange(tx, actor.companyId, { event: "issued", before: null, after: row, source: actor.source, reason: null });
      return { token, url: `${ctx.appUrl}${feedPath(token)}`, feed: { createdAt: row.createdAt, lastUsedAt: null, hint: tokenHint } };
    }),
  );
}

import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { type FeedKind, isFeedKind } from "@/shared/kernel/calendar-feed";
import type { ServiceContext } from "@/server/context";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { revokeLiveFeed } from "@/modules/calendar/infrastructure/drizzle-calendar-feeds.repository";
import { asMember, recordFeedChange } from "@/modules/calendar/application/feed-changes";

/**
 * Turns off the actor's live feed of `kind`: its link answers 404 from now on.
 *
 * @returns `false` when there was no live link (nothing changes or is recorded). Fails
 *   with `invalid_input` (unknown kind) or `forbidden` (inactive member).
 */
export async function revokeCalendarFeed(ctx: ServiceContext, actor: Actor, kind: FeedKind): Promise<ServiceResult<boolean>> {
  if (!isFeedKind(kind)) return err("invalid_input");
  return attempt(() =>
    asMember(ctx, actor, async (tx) => {
      const old = await revokeLiveFeed(tx, { userId: actor.id, kind }, ctx.now());
      if (!old) return false;
      await recordFeedChange(tx, { event: "revoked", before: { ...old, revokedAt: null }, after: old, source: actor.source, reason: "turned_off" });
      return true;
    }),
  );
}

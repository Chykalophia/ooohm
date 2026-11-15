import "server-only";
/**
 * What every feed change shares: its audit row and `calendar_feed.*` event, and the
 * member lock a person's own feed changes run under. Neither ever carries the token or
 * its hash.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/shared/kernel/actor";
import type { PersonChangeSource } from "@/shared/kernel/change-source";
import { DomainError } from "@/shared/kernel/errors";
import {
  CALENDAR_FEED_EVENT_TYPES,
  type CalendarFeedEventPayload,
  type CalendarFeedRevokeReason,
  calendarFeedAuditAction,
  type Unattributed,
} from "@/shared/kernel/events";
import type { ServiceContext } from "@/server/context";
import { lockMember } from "@/shared/lib/db/members";
import { recordChange } from "@/shared/lib/db/change-log";
import { inTransaction } from "@/shared/lib/unit-of-work";
import type { CalendarFeedRow } from "@/modules/calendar/infrastructure/drizzle-calendar-feeds.repository";

/** The audited view of a feed: never its hash, which would be a step towards the link. */
function snapshot(row: CalendarFeedRow) {
  return { kind: row.kind, createdAt: row.createdAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null };
}

export async function recordFeedChange(
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

/** Runs `work` for the actor under their member lock, refusing an inactive member. */
export async function asMember<T>(ctx: ServiceContext, actor: Actor, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return inTransaction(ctx, async (tx) => {
    // Serialises one person's feed changes, so two clicks at once cannot leave two live links.
    const member = await lockMember(tx, actor.companyId, actor.id);
    if (!member?.isActive) throw new DomainError("forbidden");
    return work(tx);
  });
}

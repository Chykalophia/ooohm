import "server-only";
import type { Transaction } from "@/db/types";
import type { PersonChangeSource } from "@/domain/change-source";
import { revokeAllLiveFeeds } from "@/modules/calendar/infrastructure/drizzle-calendar-feeds.repository";
import { recordFeedChange } from "@/modules/calendar/application/feed-changes";

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

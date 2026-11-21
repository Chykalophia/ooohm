import "server-only";
import type { Transaction } from "@/db/types";
import type { PersonChangeSource } from "@/shared/kernel/change-source";
import { revokeAllLiveFeeds } from "@/modules/calendar/infrastructure/drizzle-calendar-feeds.repository";
import { recordFeedChange } from "@/modules/calendar/application/feed-changes";

/**
 * Turns off every live feed link of a person being deactivated, inside the caller's
 * transaction `tx`, for `companyId` (which holds their member lock). Each revoke writes
 * `audit_log` and a `calendar_feed.revoked` event with reason `deactivated` and the admin
 * as actor, in the company the link belonged to.
 *
 * @returns How many links were turned off.
 */
export async function revokeFeedsOnDeactivation(tx: Transaction, companyId: string, userId: string, admin: PersonChangeSource, at: Date): Promise<number> {
  const revoked = await revokeAllLiveFeeds(tx, userId, at);
  for (const row of revoked) {
    await recordFeedChange(tx, companyId, { event: "revoked", before: { ...row, revokedAt: null }, after: row, source: admin, reason: "deactivated" });
  }
  return revoked.length;
}

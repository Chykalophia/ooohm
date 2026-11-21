import "server-only";
import { forTenant } from "@/shared/lib/tenant";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { hasApprovedRequest } from "@/shared/lib/db/leave-requests";
import { hasLiveFeedIn } from "@/modules/calendar/infrastructure/drizzle-calendar-feeds.repository";

/**
 * Whether Home should suggest a calendar link: the person has approved time off in
 * their company (any dates, not only among the requests Home lists) and has no live
 * link issued in that company. A link left over from a company they have since left
 * doesn't count, since it serves nothing here. Two queries; never fails.
 */
export async function shouldSuggestCalendarFeed(ctx: ServiceContext, actor: Actor): Promise<boolean> {
  ctx = forTenant(ctx, actor.companyId);
  const [approved, linked] = await Promise.all([hasApprovedRequest(ctx.db, actor.companyId, actor.id), hasLiveFeedIn(ctx.db, actor.companyId, actor.id)]);
  return approved && !linked;
}

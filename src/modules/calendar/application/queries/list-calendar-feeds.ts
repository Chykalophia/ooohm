import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { FeedKind } from "@/shared/kernel/calendar-feed";
import type { ServiceContext } from "@/server/context";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import { findCompanySettings } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";
import { listLiveFeeds } from "@/modules/calendar/infrastructure/drizzle-calendar-feeds.repository";
import { type CalendarFeedsDTO, toFeedSummary } from "@/modules/calendar/application/dto";

/**
 * The actor's live feeds by kind (`null` for a kind with no live link), and the
 * company's time zone for showing their dates. Includes a link issued in a company the
 * actor has since left: it answers 404 while they are elsewhere, but would work again
 * if they moved back, so they must be able to see it and turn it off.
 *
 * Fails with `no_company` when the actor's company is missing.
 */
export async function listCalendarFeeds(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<CalendarFeedsDTO>> {
  const [settings, rows] = await Promise.all([findCompanySettings(ctx.db, actor.companyId), listLiveFeeds(ctx.db, actor.id)]);
  if (!settings) return err("no_company");
  const summary = (kind: FeedKind) => {
    const row = rows.find((r) => r.kind === kind);
    return row ? toFeedSummary(row) : null;
  };
  return ok({ timezone: settings.timezone, feeds: { personal: summary("personal"), team: summary("team") } });
}

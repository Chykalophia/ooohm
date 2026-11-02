import { runAppTick, tickCounts } from "@/app/background";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { handleCronTick } from "./handler";

/**
 * Covers the tick's budget (`OOOHM_TICK_BUDGET_MS`, 15 s by default), a webhook attempt
 * still in flight when it runs out (10 s), and a daily job.
 */
export const maxDuration = 60;

/**
 * One background tick for an external scheduler: Vercel Cron (see vercel.json), or any
 * cron or uptime service on Railway, Render, Fly or a VM, sending
 * `Authorization: Bearer $CRON_SECRET`. Dispatches events, delivers due webhooks and
 * adapter deliveries (retries included), and runs the daily jobs when due. Safe to call
 * as often as you like and from several places at once.
 */
export async function GET(request: Request) {
  return handleCronTick(request, {
    secret: env.CRON_SECRET,
    tick: async () => {
      try {
        const summary = await runAppTick();
        log.info(tickCounts(summary), "cron_tick");
        return tickCounts(summary);
      } catch (err) {
        log.error({ err }, "cron_tick_failed");
        throw err;
      }
    },
    onUnconfigured: () => log.warn({}, "cron_secret_unset"),
  });
}

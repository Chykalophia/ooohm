import "server-only";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { createSafeFetch } from "@/lib/safe-fetch";
import { backgroundContext } from "@/server/runtime";
import { createTickScheduler, runTick, type TickSummary, tickDidWork } from "@/server/services/background-tick";

/**
 * The app's side of background work (see src/lib/background-mode.ts): one tick function
 * shared by the cron route, the inline after-change tick and embedded mode's interval
 * runner, all running `runTick` with the app's settings.
 */

const fetch = createSafeFetch({ allowInsecure: env.WEBHOOK_ALLOW_INSECURE, allowPrivate: env.WEBHOOK_ALLOW_PRIVATE });

/** One bounded tick in the app's process, within `OOOHM_TICK_BUDGET_MS`. Throws on a database error. */
export function runAppTick(): Promise<TickSummary> {
  return runTick(backgroundContext(), { fetch, budgetMs: env.OOOHM_TICK_BUDGET_MS });
}

/** The counts of a summary, flat, for a log line or a JSON response. */
export function tickCounts(s: TickSummary) {
  return {
    events: s.events,
    webhooksAttempted: s.webhooks.attempted,
    webhooksDelivered: s.webhooks.delivered,
    webhooksRetried: s.webhooks.retried,
    webhooksFailed: s.webhooks.failed,
    adaptersAttempted: s.adapters.attempted,
    adaptersDelivered: s.adapters.delivered,
    jobs: s.jobs,
    stoppedEarly: s.stoppedEarly,
    durationMs: s.durationMs,
  };
}

const processState = globalThis as unknown as { ooohmTicks?: ReturnType<typeof createTickScheduler>; ooohmInterval?: NodeJS.Timeout };

/**
 * This process's tick scheduler: requests made while a tick runs are folded into one more
 * pass, so a burst of changes never starts ticks side by side. Errors are logged, never
 * thrown: callers are `after()` callbacks and timers.
 */
function scheduler() {
  processState.ooohmTicks ??= createTickScheduler(async () => {
    try {
      const summary = await runAppTick();
      if (tickDidWork(summary)) log.info(tickCounts(summary), "background_tick");
    } catch (err) {
      log.error({ err }, "background_tick_failed");
    }
  });
  return processState.ooohmTicks;
}

/** Runs (or joins) a tick; resolves when it has finished. Never throws. */
export function requestTick(): Promise<void> {
  return scheduler().request();
}

/**
 * Starts the interval runner for embedded mode: a tick every `OOOHM_TICK_INTERVAL_SECONDS`,
 * for retries and the daily jobs. Once per process; the timer does not keep the process alive.
 */
export function startIntervalRunner(): void {
  if (processState.ooohmInterval) return;
  const everyMs = env.OOOHM_TICK_INTERVAL_SECONDS * 1000;
  processState.ooohmInterval = setInterval(() => void requestTick(), everyMs);
  processState.ooohmInterval.unref();
  void requestTick();
  log.info({ everySeconds: env.OOOHM_TICK_INTERVAL_SECONDS }, "background_interval_started");
}

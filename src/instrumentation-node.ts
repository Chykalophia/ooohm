import { startIntervalRunner, requestTick } from "@/app/background";
import { databaseKind, openAppDatabase } from "@/db";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { setBackgroundWake } from "@/server/runtime";

/**
 * Process start-up for the Node.js server (called from `instrumentation.ts`):
 *
 * 1. embedded mode: opens the data directory (refusing if another process holds it) and
 *    applies pending migrations, before the first request;
 * 2. `inline` background mode: registers the after-change tick (`ctx.wake`);
 * 3. embedded mode: starts the interval runner, since no worker may run beside it.
 */
export async function startBackground(): Promise<void> {
  await openAppDatabase();
  if (env.background === "inline") setBackgroundWake(requestTick);
  if (databaseKind === "embedded") startIntervalRunner();
  log.info({ database: databaseKind, background: env.background }, "server_started");
}

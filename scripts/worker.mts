/**
 * The outbox worker: `pnpm worker` (the `worker` service in docker-compose).
 *
 * Four loops share one small connection pool. Each runs one step of the shared tick
 * (`runTick`, src/server/services/background-tick.ts), the same code the cron route and
 * the app's inline mode run:
 *
 * - **dispatch**: fans new `events_outbox` rows out into webhook and adapter deliveries
 *   (`dispatchOutboxBatch`);
 * - **deliver**: sends due webhook deliveries, signed, scheduling retries
 *   (`deliverDueWebhooks`);
 * - **adapters**: hands due adapter deliveries to their adapters, with the same retries
 *   (`deliverDueAdapterEvents`); separate from **deliver** so a slow adapter never
 *   delays webhooks;
 * - **jobs**: once a minute, runs whichever daily job is due (the year rollover, retention)
 *   if this worker wins its claim (`runDueJobs`).
 *
 * With the embedded database it refuses to start while the app has the data directory
 * open: the app runs this work itself there.
 *
 * A loop that found work goes again at once; an idle one waits WORKER_POLL_INTERVAL_MS,
 * doubling up to WORKER_MAX_IDLE_MS. Any number of workers can run at once: every claim
 * uses `FOR UPDATE SKIP LOCKED` or a compare-and-set.
 *
 * SIGTERM or SIGINT stops it gracefully: no new batch or claim starts, webhook attempts in
 * flight finish (at most the 10-second delivery timeout) while the unstarted rest of
 * their batch is released for the next worker, an adapter call in flight sees its
 * `AdapterContext.signal` abort and its delivery is released too (no attempt spent),
 * then the pool closes. A second signal exits at once;
 * anything in flight is retried by the next worker after its lease.
 *
 * It needs only the database settings, WEBHOOK_ENCRYPTION_KEY and, optionally, LOG_LEVEL,
 * WEBHOOK_ALLOW_INSECURE, WEBHOOK_ALLOW_PRIVATE and the two WORKER_* intervals (see
 * src/lib/worker-env.ts). It never sees the auth secret or SMTP credentials.
 */
import { openDatabase } from "../src/db/connect";
import { createSecretBox } from "../src/lib/integration-crypto";
import { log } from "../src/lib/log";
import { createSafeFetch } from "../src/lib/safe-fetch";
import { loadWorkerEnv } from "../src/lib/worker-env";
import type { ServiceContext } from "../src/server/context";
import { adapterRegistry } from "../src/server/integrations/adapter";
import { ping } from "../src/server/repositories/health";
import { runTick, type TickStep } from "../src/server/services/background-tick";

/** How long one loop pass may keep starting new work before the loop checks in again. */
const STEP_BUDGET_MS = 30_000;

const env = loadWorkerEnv();
const webhookTargets = { allowInsecure: env.WEBHOOK_ALLOW_INSECURE, allowPrivate: env.WEBHOOK_ALLOW_PRIVATE };
// Embedded mode: refuses (with who holds it) while the app has the data directory open.
const handle = await openDatabase(env.database, { purpose: "pnpm worker", max: 5 });
const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`The worker does not ${what}.`);
};

const ctx: ServiceContext = {
  db: handle.db,
  mailer: refuse("send email"),
  defer: (task) => void task(),
  appUrl: "",
  now: () => new Date(),
  issueSignInLink: refuse("sign anyone in"),
  secrets: createSecretBox(env.WEBHOOK_ENCRYPTION_KEY),
  webhookTargets,
  adapters: adapterRegistry,
};
const fetch = createSafeFetch(webhookTargets);
const stop = new AbortController();

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Runs `step` until stopped. `step` returns whether it found work; idle loops back off. */
async function loop(name: string, step: () => Promise<boolean>, idle = { min: env.WORKER_POLL_INTERVAL_MS, max: env.WORKER_MAX_IDLE_MS }) {
  let wait = idle.min;
  while (!stop.signal.aborted) {
    let busy = false;
    try {
      busy = await step();
    } catch (err) {
      log.error({ loop: name, err }, "worker_loop_failed");
    }
    if (busy) {
      wait = idle.min;
      continue;
    }
    await sleep(wait, stop.signal);
    wait = Math.min(wait * 2, idle.max);
  }
}

let signals = 0;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    signals++;
    if (signals > 1) {
      log.warn({ signal }, "worker_forced_exit");
      process.exit(1);
    }
    log.info({ signal }, "worker_stopping");
    stop.abort();
  });
}

await ping(handle.db);
log.info(
  {
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    maxIdleMs: env.WORKER_MAX_IDLE_MS,
    adapters: adapterRegistry.list().map((a) => a.id),
    allowInsecure: webhookTargets.allowInsecure,
    allowPrivate: webhookTargets.allowPrivate,
  },
  "worker_started",
);

/** One step of the shared tick (`runTick`), the same code the cron route and the app's inline ticks run. */
const step = (only: TickStep) => runTick(ctx, { fetch, signal: stop.signal, steps: [only], budgetMs: STEP_BUDGET_MS });

await Promise.all([
  loop("dispatch", async () => {
    const r = await step("dispatch");
    if (r.events > 0) log.debug({ events: r.events, webhookDeliveries: r.webhookDeliveriesCreated, adapterDeliveries: r.adapterDeliveriesCreated }, "outbox_dispatched");
    return r.events > 0;
  }),
  loop("deliver", async () => (await step("webhooks")).webhooks.attempted > 0),
  // Its own loop: a slow or hanging adapter (up to 20 calls of 30 s each per pass) never
  // holds up webhook delivery.
  loop("adapters", async () => (await step("adapters")).adapters.attempted > 0),
  loop(
    "jobs",
    async () => {
      await step("jobs");
      return false;
    },
    { min: 60_000, max: 60_000 },
  ),
]);

await handle.close();
log.info({}, "worker_stopped");

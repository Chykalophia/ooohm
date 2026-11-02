/**
 * One bounded pass of OOOhm's background work: the single code path behind the outbox
 * worker's loops, the cron route (`/api/cron/tick`), the after-change inline tick and the
 * embedded mode's interval runner.
 *
 * A tick fans new outbox events out into deliveries, sends due webhook deliveries,
 * hands due adapter deliveries to their adapters, and runs whichever daily job is due,
 * in that order, starting new work only within its time budget. Every claim it makes is
 * `FOR UPDATE SKIP LOCKED` or a compare-and-set, so any number of ticks (and workers) can
 * run at once and repeatedly: nothing is dispatched or sent twice in normal operation,
 * and a daily job runs once a day.
 */
import type { WebhookFetch } from "@/lib/safe-fetch";
import type { ServiceContext } from "@/server/context";
import { type AdapterRunResult, deliverDueAdapterEvents } from "./adapter-delivery";
import { dispatchOutboxBatch } from "./outbox-dispatch";
import { runDueJobs } from "./scheduled-jobs";
import { deliverDueWebhooks, type DeliveryRunResult } from "./webhook-delivery";

export const TICK_STEPS = ["dispatch", "webhooks", "adapters", "jobs"] as const;
export type TickStep = (typeof TICK_STEPS)[number];

/** The default budget: long enough to clear a burst, short enough for any serverless limit. */
export const DEFAULT_TICK_BUDGET_MS = 15_000;

export interface TickDeps {
  /** The webhook transport (`createSafeFetch(...)`). */
  fetch: WebhookFetch;
  /**
   * How long the tick may keep starting new work. Work in flight when it runs out
   * finishes (a webhook attempt within its 10-second timeout); an adapter call in flight
   * is cut short and released, as on a worker shutdown. Default 15 s.
   */
  budgetMs?: number;
  /** Stops the tick early (the worker's shutdown signal). */
  signal?: AbortSignal;
  /** Which steps to run; all by default. The worker gives each of its loops one step. */
  steps?: readonly TickStep[];
  /** For tests: the clock used to measure the budget. */
  monotonicNow?: () => number;
}

/** Counts only: safe to return from the cron route and to log. */
export interface TickSummary {
  /** Outbox events fanned out into deliveries. */
  events: number;
  webhookDeliveriesCreated: number;
  adapterDeliveriesCreated: number;
  webhooks: DeliveryRunResult;
  adapters: AdapterRunResult;
  /** Daily jobs this tick claimed and ran. */
  jobs: number;
  /** True when the budget ran out (or the tick was stopped) with work possibly left. */
  stoppedEarly: boolean;
  durationMs: number;
}

function addInto<T extends object>(total: T, part: T): void {
  for (const key of Object.keys(part) as (keyof T)[]) {
    (total[key] as number) += part[key] as number;
  }
}

/**
 * Runs one bounded pass. Each step repeats while it finds work and the budget lasts, so
 * one tick clears a burst of events, not just one batch. Never throws for a single
 * delivery's failure (those are recorded and retried); a database error propagates, and
 * callers log it.
 */
export async function runTick(ctx: ServiceContext, deps: TickDeps): Promise<TickSummary> {
  const clock = deps.monotonicNow ?? (() => performance.now());
  const started = clock();
  const budget = deps.budgetMs ?? DEFAULT_TICK_BUDGET_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budget);
  timer.unref?.();
  const signal = deps.signal ? AbortSignal.any([deadline.signal, deps.signal]) : deadline.signal;
  const steps = new Set(deps.steps ?? TICK_STEPS);
  const remains = () => !signal.aborted && clock() - started < budget;

  const summary: TickSummary = {
    events: 0,
    webhookDeliveriesCreated: 0,
    adapterDeliveriesCreated: 0,
    webhooks: { attempted: 0, delivered: 0, retried: 0, failed: 0 },
    adapters: { attempted: 0, delivered: 0, retried: 0, failed: 0 },
    jobs: 0,
    stoppedEarly: false,
    durationMs: 0,
  };

  const deliver = async () => {
    if (steps.has("dispatch")) {
      while (remains()) {
        const r = await dispatchOutboxBatch(ctx);
        summary.events += r.events;
        summary.webhookDeliveriesCreated += r.webhookDeliveries;
        summary.adapterDeliveriesCreated += r.adapterDeliveries;
        if (r.events === 0) break;
      }
    }
    if (steps.has("webhooks")) {
      while (remains()) {
        const r = await deliverDueWebhooks(ctx, { fetch: deps.fetch, signal });
        addInto(summary.webhooks, r);
        if (r.attempted === 0) break;
      }
    }
    if (steps.has("adapters")) {
      while (remains()) {
        const r = await deliverDueAdapterEvents(ctx, { signal });
        addInto(summary.adapters, r);
        if (r.attempted === 0) break;
      }
    }
  };

  try {
    await deliver();
    if (steps.has("jobs") && remains()) {
      summary.jobs = (await runDueJobs(ctx)).length;
      // A job's changes (the rollover's balance events) go out in the same tick.
      if (summary.jobs > 0) await deliver();
    }
  } finally {
    clearTimeout(timer);
    summary.stoppedEarly = signal.aborted || clock() - started >= budget;
    summary.durationMs = Math.round(clock() - started);
  }
  return summary;
}

/** Whether a summary did anything worth a log line. */
export function tickDidWork(s: TickSummary): boolean {
  return s.events + s.webhooks.attempted + s.adapters.attempted + s.jobs > 0;
}

/**
 * Coalesces tick requests within one process: while a tick runs, further requests mark
 * it to go once more when it ends, instead of starting ticks side by side. Each request's
 * promise settles when the tick that covers it has finished, so `after()` (or Vercel's
 * `waitUntil`) keeps the instance alive until its change has been delivered. `run` must
 * not throw.
 */
export function createTickScheduler(run: () => Promise<void>): { request(): Promise<void>; idle(): Promise<void> } {
  let current: Promise<void> | null = null;
  let again = false;
  return {
    request() {
      if (current) {
        again = true;
        return current;
      }
      current = (async () => {
        do {
          again = false;
          await run();
        } while (again);
      })().finally(() => {
        current = null;
      });
      return current;
    },
    idle: () => current ?? Promise.resolve(),
  };
}

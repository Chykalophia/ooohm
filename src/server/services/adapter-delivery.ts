/**
 * Outbound adapter sync: the outbox worker hands due adapter deliveries to their
 * adapters, with the webhook retry schedule. Nothing runs here in v1, which registers no
 * adapters.
 */
import { buildEnvelope, retryDelayMs } from "@/domain/integrations";
import { log } from "@/lib/log";
import { describeTransportError } from "@/lib/safe-fetch";
import type { ServiceContext } from "@/server/context";
import {
  type AdapterOutcome,
  type ClaimedAdapterDelivery,
  claimDueAdapterDeliveries,
  recordAdapterOutcome,
  releaseAdapterClaim,
} from "@/server/repositories/adapter-deliveries";

/** The most deliveries one run attempts. */
export const ADAPTER_BATCH_SIZE = 20;
/** The longest one `deliver` call may take before it counts as failed. */
export const ADAPTER_TIMEOUT_MS = 30_000;
/**
 * How long one claimed delivery is reserved for the worker calling its adapter. Each
 * delivery is claimed only just before its call, so the lease covers that one call
 * ({@link ADAPTER_TIMEOUT_MS}) plus recording it, and runs out only when a worker died
 * mid-call.
 */
export const ADAPTER_LEASE_MS = 2 * 60_000;

export interface AdapterRunResult {
  attempted: number;
  delivered: number;
  retried: number;
  failed: number;
}

export interface AdapterDeliveryDeps {
  now?: () => Date;
  /** For retry jitter; defaults to `Math.random`. */
  random?: () => number;
  limit?: number;
  timeoutMs?: number;
  /**
   * The worker's shutdown signal. Once aborted, no further delivery is claimed, and the
   * call in flight sees it through `AdapterContext.signal`.
   */
  signal?: AbortSignal;
}

/** Marks a call the worker's stop cut short (or never started): released, not failed. */
const STOPPED = Symbol("worker_stopped");

/**
 * Calls the adapter for one claimed delivery.
 *
 * @returns null on success, {@link STOPPED} when the worker is stopping (the adapter is
 *   then not called at all, or its call was cut short), else a short error code.
 */
async function callAdapter(
  ctx: ServiceContext,
  claim: ClaimedAdapterDelivery,
  now: () => Date,
  timeoutMs: number,
  stop?: AbortSignal,
): Promise<string | typeof STOPPED | null> {
  const adapter = ctx.adapters.get(claim.adapterId);
  if (!adapter) return "adapter_not_registered";
  if (stop?.aborted) return STOPPED;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = stop ? AbortSignal.any([timeout, stop]) : timeout;
  let onAbort: (() => void) | undefined;
  try {
    const envelope = buildEnvelope({ ...claim.event, companyId: claim.companyId });
    // The abort listener goes on before the call, so a stop that lands while `deliver`
    // runs synchronously still ends a call that ignores its signal.
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    await Promise.race([adapter.deliver(envelope, { companyId: claim.companyId, now, signal }), aborted]);
    return null;
  } catch (err) {
    if (stop?.aborted) return STOPPED;
    return timeout.aborted ? "timeout" : describeTransportError(err);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Attempts up to `limit` due adapter deliveries, one after another. Each is claimed just
 * before its call (`SKIP LOCKED` and a lease of {@link ADAPTER_LEASE_MS}, as for
 * webhooks), so a slow adapter never holds a queue of claims whose leases run out before
 * their turn, and a second worker never calls an adapter for a delivery still in flight.
 *
 * Resolving is success; throwing or taking longer than {@link ADAPTER_TIMEOUT_MS} is a
 * failed attempt, retried on the same schedule as webhooks (`retryDelayMs`) until the 8th
 * fails. A delivery whose adapter is no longer registered fails its attempt the same way
 * (`adapter_not_registered`), so putting the adapter back resumes it. Errors are logged
 * with a short code only.
 *
 * Once `deps.signal` is aborted nothing further is claimed. A claim the stop lands on,
 * before its call or during it, is released (`releaseAdapterClaim`: due at once, attempt
 * uncounted) instead of failed, so a shutdown never spends the retry budget; the adapter
 * is never called after the stop. An interrupted call may still have reached the other
 * system, so it is delivered again (at least once).
 */
export async function deliverDueAdapterEvents(ctx: ServiceContext, deps: AdapterDeliveryDeps = {}): Promise<AdapterRunResult> {
  const now = deps.now ?? ctx.now;
  const random = deps.random ?? Math.random;
  const limit = deps.limit ?? ADAPTER_BATCH_SIZE;
  const timeoutMs = deps.timeoutMs ?? ADAPTER_TIMEOUT_MS;
  const result: AdapterRunResult = { attempted: 0, delivered: 0, retried: 0, failed: 0 };

  while (result.attempted < limit && !deps.signal?.aborted) {
    const start = now();
    const [claim] = await claimDueAdapterDeliveries(ctx.db, { now: start, leaseUntil: new Date(start.getTime() + ADAPTER_LEASE_MS), limit: 1 });
    if (!claim) break;
    result.attempted++;

    const fields = { deliveryId: claim.id, adapterId: claim.adapterId, eventId: claim.event.id, eventType: claim.event.type, attempt: claim.attempts };
    const error = await callAdapter(ctx, claim, now, timeoutMs, deps.signal);
    if (error === STOPPED) {
      result.attempted--;
      try {
        const released = await releaseAdapterClaim(ctx.db, claim, now());
        log.info({ ...fields, released }, "adapter_delivery_released");
      } catch (err) {
        // Its lease runs out instead, and that costs it one attempt.
        log.error({ ...fields, err }, "adapter_delivery_release_failed");
      }
      break;
    }
    const at = now();
    let outcome: AdapterOutcome;
    if (error === null) {
      outcome = { status: "delivered", at };
    } else {
      const delay = retryDelayMs(claim.attempts, random());
      outcome = { status: delay === null ? "failed" : "pending", at, nextAttemptAt: new Date(at.getTime() + (delay ?? 0)), error };
    }
    try {
      if (!(await recordAdapterOutcome(ctx.db, claim, outcome))) log.warn(fields, "adapter_delivery_outcome_dropped");
    } catch (err) {
      log.error({ ...fields, err }, "adapter_delivery_record_failed");
      continue;
    }
    if (outcome.status === "delivered") {
      result.delivered++;
      log.info(fields, "adapter_delivered");
    } else if (outcome.status === "failed") {
      result.failed++;
      log.error({ ...fields, error: outcome.error }, "adapter_delivery_failed");
    } else {
      result.retried++;
      log.warn({ ...fields, error: outcome.error, nextAttemptAt: outcome.nextAttemptAt.toISOString() }, "adapter_delivery_retry_scheduled");
    }
  }
  return result;
}

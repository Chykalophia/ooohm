/**
 * Step two of the outbox worker: send due webhook deliveries, signed, and schedule
 * retries.
 */
import { retryDelayMs } from "@/domain/integrations";
import { webhookRequestHeaders } from "@/lib/integration-crypto";
import { log } from "@/lib/log";
import { describeTransportError, MAX_RESPONSE_BYTES, type WebhookFetch } from "@/lib/safe-fetch";
import type { ServiceContext } from "@/server/context";
import { type ClaimedWebhookDelivery, claimDueDeliveries, type DeliveryOutcome, recordDeliveryOutcome, releaseDeliveryClaims } from "@/server/repositories/webhooks";

/** Deliveries claimed per batch. */
export const DELIVERY_BATCH_SIZE = 20;
/** Attempts in flight at once within a batch. */
export const DELIVERY_CONCURRENCY = 8;
/** The whole request, connect to last byte read. */
export const DELIVERY_TIMEOUT_MS = 10_000;
/**
 * How long a claimed delivery is reserved for the worker attempting it. Longer than any
 * attempt can take, so it only runs out when a worker died mid-attempt; the delivery is
 * then retried by whichever worker claims it next.
 */
export const DELIVERY_LEASE_MS = 2 * 60_000;
/** Characters of a response body kept for the admin screen. */
export const RESPONSE_EXCERPT_LENGTH = 200;

export interface DeliveryDeps {
  /** The transport; the worker passes `createSafeFetch(...)`. */
  fetch: WebhookFetch;
  /** The clock for due times, leases and signatures; defaults to `ctx.now`. */
  now?: () => Date;
  /** For retry jitter; defaults to `Math.random`. */
  random?: () => number;
  limit?: number;
  concurrency?: number;
  timeoutMs?: number;
  /**
   * The worker's shutdown signal. Once aborted, attempts in flight finish (each within
   * its timeout) but no further claim of the batch is started: those are released, due
   * at once for the next worker, without spending an attempt.
   */
  signal?: AbortSignal;
}

export interface DeliveryRunResult {
  attempted: number;
  delivered: number;
  /** Failed attempts with a retry scheduled. */
  retried: number;
  /** Failed attempts that were the last allowed: the delivery is now `failed`. */
  failed: number;
}

/** Reads at most `max` bytes of a response body and returns a short, single-line excerpt. */
async function excerptOf(res: Response, max = MAX_RESPONSE_BYTES): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).subarray(0, max).toString("utf8");
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line ? line.slice(0, RESPONSE_EXCERPT_LENGTH) : null;
}

/**
 * Runs `work` over `items`, at most `limit` at a time, starting no new item once
 * `signal` is aborted. @returns The items never started.
 */
async function inParallel<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>, signal?: AbortSignal): Promise<T[]> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) await work(items[next++]);
  });
  await Promise.all(lanes);
  return items.slice(next);
}

/**
 * One attempt: sign with the endpoint's current secret and the attempt's timestamp, POST
 * the stored body with a timeout, and describe the outcome. 2xx is success; anything
 * else (3xx included: redirects are never followed), a timeout, a refused or blocked
 * address, or an unreadable secret is a failed attempt.
 */
async function attempt(ctx: ServiceContext, claim: ClaimedWebhookDelivery, deps: Required<Pick<DeliveryDeps, "fetch" | "timeoutMs">>, startedAt: Date) {
  let secret: string;
  try {
    secret = ctx.secrets.open(claim.secretCiphertext, claim.endpointId);
  } catch {
    return { ok: false as const, statusCode: null, latencyMs: null, error: "secret_unreadable", excerpt: null };
  }
  const headers = webhookRequestHeaders({
    secret,
    eventId: claim.eventId,
    eventType: claim.eventType,
    timestamp: Math.floor(startedAt.getTime() / 1000),
    body: claim.body,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  const started = performance.now();
  try {
    const res = await deps.fetch(claim.url, { method: "POST", headers, body: claim.body, signal: controller.signal });
    const excerpt = await excerptOf(res);
    const latencyMs = Math.round(performance.now() - started);
    if (res.status >= 200 && res.status < 300) return { ok: true as const, statusCode: res.status, latencyMs, excerpt };
    return { ok: false as const, statusCode: res.status, latencyMs, error: `HTTP ${res.status}`, excerpt };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    return { ok: false as const, statusCode: null, latencyMs, error: controller.signal.aborted ? "timeout" : describeTransportError(err), excerpt: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claims up to `limit` due deliveries (see `claimDueDeliveries`: `SKIP LOCKED` and a
 * lease, so several workers share the work without sending anything twice in normal
 * operation) and attempts them, `concurrency` at a time. Each outcome is recorded with a
 * compare-and-set on the claim:
 *
 * - success: `delivered`, with status code, latency and a short response excerpt;
 * - failure with attempts left: still `pending`, due after the next wait of the retry
 *   schedule (`retryDelayMs`: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h, with jitter);
 * - failure on the 8th attempt: `failed`.
 *
 * Once `deps.signal` is aborted, attempts in flight finish and the rest of the batch is
 * released unattempted (`releaseDeliveryClaims`), so stopping takes at most one
 * attempt's timeout.
 *
 * Log lines carry ids, status codes and short error codes; never a URL, secret,
 * signature or body.
 */
export async function deliverDueWebhooks(ctx: ServiceContext, deps: DeliveryDeps): Promise<DeliveryRunResult> {
  const now = deps.now ?? ctx.now;
  const random = deps.random ?? Math.random;
  if (deps.signal?.aborted) return { attempted: 0, delivered: 0, retried: 0, failed: 0 };
  const start = now();
  const claims = await claimDueDeliveries(ctx.db, {
    now: start,
    leaseUntil: new Date(start.getTime() + DELIVERY_LEASE_MS),
    limit: deps.limit ?? DELIVERY_BATCH_SIZE,
  });
  const result: DeliveryRunResult = { attempted: claims.length, delivered: 0, retried: 0, failed: 0 };
  const run = { fetch: deps.fetch, timeoutMs: deps.timeoutMs ?? DELIVERY_TIMEOUT_MS };

  const unstarted = await inParallel(claims, deps.concurrency ?? DELIVERY_CONCURRENCY, async (claim) => {
    const outcome = await attempt(ctx, claim, run, now());
    const at = now();
    let recorded: DeliveryOutcome;
    if (outcome.ok) {
      recorded = { status: "delivered", at, statusCode: outcome.statusCode, latencyMs: outcome.latencyMs, excerpt: outcome.excerpt };
    } else {
      const delay = retryDelayMs(claim.attempts, random());
      recorded = {
        status: delay === null ? "failed" : "pending",
        at,
        nextAttemptAt: new Date(at.getTime() + (delay ?? 0)),
        statusCode: outcome.statusCode,
        latencyMs: outcome.latencyMs,
        error: outcome.error,
        excerpt: outcome.excerpt,
      };
    }
    const fields = { deliveryId: claim.id, endpointId: claim.endpointId, eventId: claim.eventId, eventType: claim.eventType, attempt: claim.attempts };
    try {
      const kept = await recordDeliveryOutcome(ctx.db, claim, recorded);
      if (!kept) log.warn(fields, "webhook_delivery_outcome_dropped");
    } catch (err) {
      // The lease runs out and another attempt follows: at least once, never lost.
      log.error({ ...fields, err }, "webhook_delivery_record_failed");
      return;
    }
    if (recorded.status === "delivered") {
      result.delivered++;
      log.info({ ...fields, statusCode: recorded.statusCode, latencyMs: recorded.latencyMs }, "webhook_delivered");
    } else {
      if (recorded.status === "failed") result.failed++;
      else result.retried++;
      const level = recorded.status === "failed" ? log.error : log.warn;
      level(
        { ...fields, statusCode: recorded.statusCode, error: recorded.error, nextAttemptAt: recorded.status === "pending" ? recorded.nextAttemptAt.toISOString() : null },
        recorded.status === "failed" ? "webhook_delivery_failed" : "webhook_delivery_retry_scheduled",
      );
    }
  }, deps.signal);
  if (unstarted.length > 0) {
    result.attempted -= unstarted.length;
    try {
      const released = await releaseDeliveryClaims(ctx.db, unstarted, now());
      log.info({ released }, "webhook_deliveries_released");
    } catch (err) {
      // Their leases run out instead; each costs one attempt.
      log.error({ count: unstarted.length, err }, "webhook_delivery_release_failed");
    }
  }
  return result;
}

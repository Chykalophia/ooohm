/**
 * Retention of integration data. The audit log is never pruned; only the delivery
 * machinery is.
 */
import type { ServiceContext } from "@/server/context";
import { pruneDispatchedEvents, pruneFinishedAdapterDeliveries, pruneFinishedWebhookDeliveries } from "@/server/repositories/retention";

/** Days kept of finished deliveries and of dispatched outbox events (which `/api/v1/events` replays). */
export const RETENTION_DAYS = 90;
const BATCH = 1_000;

export interface PruneResult {
  webhookDeliveries: number;
  adapterDeliveries: number;
  events: number;
}

async function drain(prune: (batch: number) => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await prune(BATCH);
    total += n;
    if (n < BATCH) return total;
  }
}

/**
 * Deletes, in batches of 1,000, what is older than `retentionDays`: finished (delivered,
 * failed or cancelled) webhook and adapter deliveries, by when they last changed, then
 * dispatched outbox events, by when they were written, unless an adapter still has one
 * pending. Pending deliveries and undispatched events are kept however old.
 * Deliveries go first, so an event is never deleted under a delivery still being shown.
 */
export async function pruneIntegrationData(ctx: ServiceContext, options: { now?: Date; retentionDays?: number } = {}): Promise<PruneResult> {
  const now = options.now ?? ctx.now();
  const before = new Date(now.getTime() - (options.retentionDays ?? RETENTION_DAYS) * 86_400_000);
  const webhookDeliveries = await drain((n) => pruneFinishedWebhookDeliveries(ctx.db, before, n));
  const adapterDeliveries = await drain((n) => pruneFinishedAdapterDeliveries(ctx.db, before, n));
  const events = await drain((n) => pruneDispatchedEvents(ctx.db, before, n));
  return { webhookDeliveries, adapterDeliveries, events };
}

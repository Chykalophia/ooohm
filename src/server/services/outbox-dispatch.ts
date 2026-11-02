/**
 * Step one of the outbox worker: fan new outbox events out into deliveries.
 */
import { buildEnvelope } from "@/domain/integrations";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import type { Adapter } from "@/server/integrations/adapter";
import { insertAdapterDeliveries, type NewAdapterDelivery } from "@/server/repositories/adapter-deliveries";
import { claimUndispatched, markDispatched } from "@/server/repositories/outbox";
import { insertDeliveries, listDispatchTargets, type NewWebhookDelivery } from "@/server/repositories/webhooks";

/**
 * Asks an adapter whether it wants an event. Adapter code is not core code: a throw
 * counts as "no" and is logged, so one faulty adapter can never roll back the batch and
 * stall dispatch for every webhook and other adapter.
 */
function adapterHandles(adapter: Adapter, eventType: string, companyId: string): boolean {
  try {
    return adapter.handles(eventType, companyId) === true;
  } catch (err) {
    log.error({ adapterId: adapter.id, eventType, companyId, err }, "adapter_handles_failed");
    return false;
  }
}

/** Events fanned out per batch (and per transaction). */
export const DISPATCH_BATCH_SIZE = 100;

export interface DispatchResult {
  /** Outbox events dispatched (marked `delivered_at`). */
  events: number;
  webhookDeliveries: number;
  adapterDeliveries: number;
}

/**
 * Claims up to `limit` undispatched outbox events, oldest first, and in one transaction:
 *
 * 1. creates a webhook delivery for every enabled, live endpoint of the event's company
 *    that subscribes to its type and existed when the event was written (an endpoint
 *    never receives history from before it was added);
 * 2. creates an adapter delivery for every registered adapter (`ctx.adapters`) whose
 *    `handles(type, companyId)` is true (none in v1; a throw counts as false);
 * 3. marks the events dispatched.
 *
 * The claim uses `FOR UPDATE SKIP LOCKED`, so any number of workers can run this at once:
 * each event is dispatched by exactly one of them, and none waits for another. The unique
 * (endpoint, event) and (adapter, event) indexes make a repeat harmless besides. Each
 * delivery's body is the event's envelope as JSON, fixed now so every retry sends the
 * same bytes; it is due at once.
 */
export async function dispatchOutboxBatch(ctx: ServiceContext, options: { limit?: number } = {}): Promise<DispatchResult> {
  const limit = options.limit ?? DISPATCH_BATCH_SIZE;
  const adapters = ctx.adapters.list();
  return ctx.db.transaction(async (tx) => {
    const events = await claimUndispatched(tx, limit);
    if (events.length === 0) return { events: 0, webhookDeliveries: 0, adapterDeliveries: 0 };
    const now = ctx.now();
    const companyIds = [...new Set(events.flatMap((e) => (e.companyId ? [e.companyId] : [])))];
    const targets = await listDispatchTargets(tx, companyIds);

    const webhookRows: NewWebhookDelivery[] = [];
    const adapterRows: NewAdapterDelivery[] = [];
    for (const event of events) {
      // Every recorded change has a company; a row without one has nobody to go to.
      if (!event.companyId) continue;
      const envelope = buildEnvelope({ ...event, companyId: event.companyId });
      const body = JSON.stringify(envelope);
      for (const target of targets) {
        if (target.companyId !== event.companyId || !target.eventTypes.includes(event.type)) continue;
        if (target.createdAt.getTime() > event.createdAt.getTime()) continue;
        webhookRows.push({ companyId: event.companyId, endpointId: target.id, eventId: event.id, eventType: event.type, body, nextAttemptAt: now });
      }
      for (const adapter of adapters) {
        if (adapterHandles(adapter, event.type, event.companyId)) {
          adapterRows.push({ companyId: event.companyId, adapterId: adapter.id, eventId: event.id, nextAttemptAt: now });
        }
      }
    }
    const webhookIds = await insertDeliveries(tx, webhookRows);
    const adapterCount = await insertAdapterDeliveries(tx, adapterRows);
    await markDispatched(
      tx,
      events.map((e) => e.id),
      now,
    );
    return { events: events.length, webhookDeliveries: webhookIds.length, adapterDeliveries: adapterCount };
  });
}

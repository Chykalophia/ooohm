import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { INTEGRATION_EVENT_TYPES } from "@/domain/events";
import type { ServiceContext } from "@/server/context";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { PING_EVENT_TYPE } from "@/modules/integrations/domain/integrations";
import { insertDeliveries } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import { canManageWebhooks } from "@/modules/integrations/application/policies";
import { pingEnvelope, recordEndpointChange, withEndpoint } from "@/modules/integrations/application/webhook-changes";

/**
 * Queues a `ping` to one endpoint, whatever it subscribes to, due at once. The worker
 * signs and sends it like any delivery, with the same retries. Refused for a disabled
 * endpoint, since nothing would send it.
 *
 * @returns The delivery's id. Fails with `forbidden`, `not_found`, or `conflict` (the endpoint is off).
 */
export async function sendWebhookPing(ctx: ServiceContext, actor: Actor, id: string): Promise<ServiceResult<string>> {
  if (!canManageWebhooks(actor)) return err("forbidden");
  return attempt(() =>
    withEndpoint(ctx, actor, id, async (tx, row) => {
      if (!row.enabled) throw new DomainError("conflict");
      const now = ctx.now();
      const envelope = pingEnvelope({ id: ctx.ids.next(), endpoint: row, now });
      const [deliveryId] = await insertDeliveries(tx, [
        { companyId: row.companyId, endpointId: row.id, eventId: envelope.id, eventType: PING_EVENT_TYPE, body: JSON.stringify(envelope), nextAttemptAt: now },
      ]);
      await recordEndpointChange(tx, actor, INTEGRATION_EVENT_TYPES.webhookEndpointPinged, row, row);
      return deliveryId;
    }),
  );
}

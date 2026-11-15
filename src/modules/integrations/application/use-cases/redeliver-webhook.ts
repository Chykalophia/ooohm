import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { INTEGRATION_EVENT_TYPES } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import type { ServiceContext } from "@/server/context";
import { recordAdminChange } from "@/shared/lib/admin-access";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { lockDelivery, requeueDelivery } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import { canManageWebhooks } from "@/modules/integrations/application/policies";
import { withEndpoint } from "@/modules/integrations/application/webhook-changes";

/**
 * Queues a finished delivery (delivered, failed or cancelled) again, with the same body
 * and event id and a fresh set of attempts, due at once. A delivery still pending is
 * already queued.
 *
 * Fails with `forbidden`, `not_found`, or `conflict` (still pending, or the endpoint is off).
 */
export async function redeliverWebhook(ctx: ServiceContext, actor: Actor, endpointId: string, deliveryId: string): Promise<ServiceResult<void>> {
  if (!isUuid(deliveryId)) return err("not_found");
  if (!canManageWebhooks(actor)) return err("forbidden");
  return attempt(() =>
    withEndpoint(ctx, actor, endpointId, async (tx, endpoint) => {
      const delivery = await lockDelivery(tx, endpoint.id, deliveryId);
      if (!delivery) throw new DomainError("not_found");
      if (delivery.status === "pending" || !endpoint.enabled) throw new DomainError("conflict");
      await requeueDelivery(tx, delivery.id, ctx.now());
      await recordAdminChange(tx, actor, {
        type: INTEGRATION_EVENT_TYPES.webhookDeliveryRedelivered,
        entityType: "webhook_delivery",
        entityId: delivery.id,
        before: { status: delivery.status, attempts: delivery.attempts },
        after: { status: "pending", attempts: 0 },
        payload: { endpointId: endpoint.id, deliveryId: delivery.id, eventId: delivery.eventId, eventType: delivery.eventType },
      });
    }),
  );
}

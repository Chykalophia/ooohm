import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { INTEGRATION_EVENT_TYPES } from "@/shared/kernel/events";
import type { ServiceContext } from "@/server/context";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { cancelPendingDeliveries, updateEndpoint } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import { canManageWebhooks } from "@/modules/integrations/application/policies";
import { recordEndpointChange, withEndpoint } from "@/modules/integrations/application/webhook-changes";

/**
 * Deletes an endpoint (soft: deliveries and audit rows keep pointing at it) and cancels
 * its pending deliveries. It disappears from every screen and gets nothing more.
 *
 * @returns How many pending deliveries were cancelled. Fails with `forbidden` or `not_found`.
 */
export async function deleteWebhookEndpoint(ctx: ServiceContext, actor: Actor, id: string): Promise<ServiceResult<number>> {
  if (!canManageWebhooks(actor)) return err("forbidden");
  return attempt(() =>
    withEndpoint(ctx, actor, id, async (tx, before) => {
      const after = await updateEndpoint(tx, actor.companyId, id, { deletedAt: ctx.now(), enabled: false });
      const cancelled = await cancelPendingDeliveries(tx, id);
      await recordEndpointChange(tx, actor, INTEGRATION_EVENT_TYPES.webhookEndpointDeleted, before, after);
      return cancelled;
    }),
  );
}

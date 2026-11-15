import "server-only";
import type { Actor } from "@/domain/actor";
import { INTEGRATION_EVENT_TYPES } from "@/domain/events";
import type { ServiceContext } from "@/server/context";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { updateEndpoint } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import { canManageWebhooks } from "@/modules/integrations/application/policies";
import { recordEndpointChange, withEndpoint } from "@/modules/integrations/application/webhook-changes";

/**
 * Turns an endpoint on or off. While off it gets no new deliveries; ones already
 * queued wait, and resume when it is turned back on.
 *
 * @returns Whether it changed. Fails with `forbidden` or `not_found`.
 */
export async function setWebhookEndpointEnabled(ctx: ServiceContext, actor: Actor, id: string, enabled: boolean): Promise<ServiceResult<boolean>> {
  if (!canManageWebhooks(actor)) return err("forbidden");
  return attempt(() =>
    withEndpoint(ctx, actor, id, async (tx, before) => {
      if (before.enabled === enabled) return false;
      const after = await updateEndpoint(tx, actor.companyId, id, { enabled });
      const type = enabled ? INTEGRATION_EVENT_TYPES.webhookEndpointEnabled : INTEGRATION_EVENT_TYPES.webhookEndpointDisabled;
      await recordEndpointChange(tx, actor, type, before, after);
      return true;
    }),
  );
}

import "server-only";
import type { Actor } from "@/domain/actor";
import { INTEGRATION_EVENT_TYPES } from "@/domain/events";
import type { ServiceContext } from "@/server/context";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { updateEndpoint } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import { canManageWebhooks } from "@/modules/integrations/application/policies";
import type { WebhookEndpointInput } from "@/modules/integrations/application/schemas";
import { normalizeEndpointInput, recordEndpointChange, withEndpoint } from "@/modules/integrations/application/webhook-changes";

/**
 * Changes an endpoint's URL, description or event types. Records nothing when nothing
 * changed. The secret stays the same.
 *
 * @returns Whether anything changed. Fails as `createWebhookEndpoint` does (but never
 *   with `limit_reached`), or with `not_found`.
 */
export async function updateWebhookEndpoint(ctx: ServiceContext, actor: Actor, id: string, input: WebhookEndpointInput): Promise<ServiceResult<boolean>> {
  if (!canManageWebhooks(actor)) return err("forbidden");
  return attempt(async () => {
    const fields = normalizeEndpointInput(ctx, input);
    return withEndpoint(ctx, actor, id, async (tx, before) => {
      const same =
        before.url === fields.url && before.description === fields.description && before.eventTypes.join() === fields.eventTypes.join();
      if (same) return false;
      const after = await updateEndpoint(tx, actor.companyId, id, fields);
      await recordEndpointChange(tx, actor, INTEGRATION_EVENT_TYPES.webhookEndpointUpdated, before, after);
      return true;
    });
  });
}

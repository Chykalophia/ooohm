import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { INTEGRATION_EVENT_TYPES } from "@/shared/kernel/events";
import { generateWebhookSecret } from "@/lib/integration-crypto";
import type { ServiceContext } from "@/server/context";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { updateEndpoint } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import { canManageWebhooks } from "@/modules/integrations/application/policies";
import { recordEndpointChange, withEndpoint } from "@/modules/integrations/application/webhook-changes";

/**
 * Replaces an endpoint's signing secret at once: every attempt from now on, retries of
 * older events included, is signed with the new one. Returns it once.
 * Fails with `forbidden` or `not_found`.
 */
export async function rotateWebhookSecret(ctx: ServiceContext, actor: Actor, id: string): Promise<ServiceResult<{ secret: string }>> {
  if (!canManageWebhooks(actor)) return err("forbidden");
  const secret = generateWebhookSecret();
  return attempt(async () => {
    await withEndpoint(ctx, actor, id, async (tx, before) => {
      const after = await updateEndpoint(tx, actor.companyId, id, { secretCiphertext: ctx.secrets.seal(secret, id) });
      await recordEndpointChange(tx, actor, INTEGRATION_EVENT_TYPES.webhookEndpointSecretRotated, before, after);
    });
    return { secret };
  });
}

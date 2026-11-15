import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { INTEGRATION_EVENT_TYPES } from "@/domain/events";
import { generateWebhookSecret } from "@/lib/integration-crypto";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { MAX_WEBHOOK_ENDPOINTS } from "@/modules/integrations/domain/integrations";
import { countLiveEndpoints, insertEndpoint } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import { type CreatedWebhookEndpointDTO, toWebhookEndpointDTO } from "@/modules/integrations/application/dto";
import { canManageWebhooks } from "@/modules/integrations/application/policies";
import type { WebhookEndpointInput } from "@/modules/integrations/application/schemas";
import { normalizeEndpointInput, recordEndpointChange } from "@/modules/integrations/application/webhook-changes";

/**
 * Adds an endpoint and generates its signing secret. The secret is returned here only:
 * the caller shows it once, and OOOhm keeps it sealed with `ctx.secrets` (AES-256-GCM,
 * the endpoint id as additional data).
 *
 * Takes the company lock, so the {@link MAX_WEBHOOK_ENDPOINTS} cap holds under
 * concurrency. The endpoint receives events written from now on, never older ones.
 * Fails with `forbidden`, `invalid_input`, `insecure_url`, `blocked_address`, or
 * `limit_reached`.
 */
export async function createWebhookEndpoint(
  ctx: ServiceContext,
  actor: Actor,
  input: WebhookEndpointInput,
): Promise<ServiceResult<CreatedWebhookEndpointDTO>> {
  if (!canManageWebhooks(actor)) return err("forbidden");
  return attempt(async () => {
    const fields = normalizeEndpointInput(ctx, input);
    const id = ctx.ids.next();
    const secret = generateWebhookSecret();
    const secretCiphertext = ctx.secrets.seal(secret, id);
    const row = await inTransaction(ctx, async (tx) => {
      await assertActiveAdmin(tx, actor);
      if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
      if ((await countLiveEndpoints(tx, actor.companyId)) >= MAX_WEBHOOK_ENDPOINTS) throw new DomainError("limit_reached");
      const created = await insertEndpoint(tx, { id, companyId: actor.companyId, ...fields, secretCiphertext, createdBy: actor.id });
      await recordEndpointChange(tx, actor, INTEGRATION_EVENT_TYPES.webhookEndpointCreated, null, created);
      return created;
    });
    return { endpoint: toWebhookEndpointDTO(row), secret };
  });
}

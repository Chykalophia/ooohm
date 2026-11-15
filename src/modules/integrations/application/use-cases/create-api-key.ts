import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { INTEGRATION_EVENT_TYPES } from "@/domain/events";
import { generateApiKey } from "@/lib/integration-crypto";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { DEFAULT_API_SCOPES, MAX_API_KEYS, normalizeApiKeyName } from "@/modules/integrations/domain/integrations";
import { countLiveApiKeys, insertApiKey } from "@/modules/integrations/infrastructure/drizzle-api-keys.repository";
import { apiKeyEventPayload, apiKeySnapshot } from "@/modules/integrations/application/api-key-changes";
import type { CreatedApiKeyDTO } from "@/modules/integrations/application/dto";
import { canManageApiKeys } from "@/modules/integrations/application/policies";

/**
 * Creates a `read` key. The full key is returned here only; OOOhm stores its SHA-256.
 * Keys belong to the company, not to the admin who made them.
 *
 * Takes the company lock, so the {@link MAX_API_KEYS} cap holds under concurrency.
 * Fails with `forbidden`, `invalid_input` (name), or `limit_reached`.
 */
export async function createApiKey(ctx: ServiceContext, actor: Actor, input: { name: string }): Promise<ServiceResult<CreatedApiKeyDTO>> {
  if (!canManageApiKeys(actor)) return err("forbidden");
  return attempt(async () => {
    const name = normalizeApiKeyName(input.name);
    const generated = generateApiKey();
    const row = await inTransaction(ctx, async (tx) => {
      await assertActiveAdmin(tx, actor);
      if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
      if ((await countLiveApiKeys(tx, actor.companyId)) >= MAX_API_KEYS) throw new DomainError("limit_reached");
      const created = await insertApiKey(tx, {
        companyId: actor.companyId,
        name,
        prefix: generated.prefix,
        keyHash: generated.hash,
        scopes: [...DEFAULT_API_SCOPES],
        createdBy: actor.id,
      });
      await recordAdminChange(tx, actor, {
        type: INTEGRATION_EVENT_TYPES.apiKeyCreated,
        entityType: "api_key",
        entityId: created.id,
        before: null,
        after: apiKeySnapshot(created),
        payload: apiKeyEventPayload(created),
      });
      return created;
    });
    const { id, prefix, scopes, createdAt, lastUsedAt, revokedAt } = row;
    return { key: generated.key, apiKey: { id, name: row.name, prefix, scopes, createdAt, lastUsedAt, revokedAt } };
  });
}

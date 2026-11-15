import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { INTEGRATION_EVENT_TYPES } from "@/shared/kernel/events";
import { isUuid } from "@/shared/kernel/uuid";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { lockApiKey, revokeApiKey as revokeApiKeyRow } from "@/modules/integrations/infrastructure/drizzle-api-keys.repository";
import { apiKeyEventPayload, apiKeySnapshot } from "@/modules/integrations/application/api-key-changes";
import { canManageApiKeys } from "@/modules/integrations/application/policies";

/**
 * Revokes a key at once: its next request gets 401. Revoking a revoked key changes and
 * records nothing.
 *
 * @returns Whether it was live. Fails with `forbidden` or `not_found`.
 */
export async function revokeApiKey(ctx: ServiceContext, actor: Actor, id: string): Promise<ServiceResult<boolean>> {
  if (!canManageApiKeys(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(() =>
    inTransaction(ctx, async (tx) => {
      await assertActiveAdmin(tx, actor);
      const before = await lockApiKey(tx, actor.companyId, id);
      if (!before) throw new DomainError("not_found");
      if (before.revokedAt) return false;
      const after = await revokeApiKeyRow(tx, id, ctx.now());
      await recordAdminChange(tx, actor, {
        type: INTEGRATION_EVENT_TYPES.apiKeyRevoked,
        entityType: "api_key",
        entityId: id,
        before: apiKeySnapshot(before),
        after: apiKeySnapshot(after),
        payload: apiKeyEventPayload(after),
      });
      return true;
    }),
  );
}

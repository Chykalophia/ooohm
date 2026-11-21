import "server-only";
import { forTenant } from "@/shared/lib/tenant";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { findCompany } from "@/modules/organisation";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { listApiKeys as listApiKeyRows } from "@/modules/integrations/infrastructure/drizzle-api-keys.repository";
import { type ApiKeyListDTO, toApiKeyDTO } from "@/modules/integrations/application/dto";
import { canManageApiKeys } from "@/modules/integrations/application/policies";

/** The company's keys (live first, then newest), with who created each. Never a hash. Fails with `forbidden`. */
export async function listApiKeys(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<ApiKeyListDTO>> {
  if (!canManageApiKeys(actor)) return err("forbidden");
  ctx = forTenant(ctx, actor.companyId);
  return attempt(async () => {
    const [company, keys] = await Promise.all([findCompany(ctx.db, actor.companyId), listApiKeyRows(ctx.db, actor.companyId)]);
    return { timezone: company?.timezone ?? "UTC", keys: keys.map(toApiKeyDTO) };
  });
}

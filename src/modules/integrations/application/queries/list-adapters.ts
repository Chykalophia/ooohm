import "server-only";
import { forTenant } from "@/shared/lib/tenant";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { adapterHealth } from "@/modules/integrations/application/adapter-runs";
import type { AdapterSummary } from "@/modules/integrations/application/dto";
import { canManageAdapters } from "@/modules/integrations/application/policies";

/**
 * Every registered adapter with its health, checked now (in parallel, each bounded by
 * `HEALTH_CHECK_TIMEOUT_MS`). Empty in v1. Fails with `forbidden`.
 */
export async function listAdapters(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<AdapterSummary[]>> {
  if (!canManageAdapters(actor)) return err("forbidden");
  ctx = forTenant(ctx, actor.companyId);
  return attempt(() =>
    Promise.all(
      ctx.adapters.list().map(async (adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        syncs: Boolean(adapter.syncUsers || adapter.syncBalances),
        ...(await adapterHealth(ctx, adapter, actor.companyId)),
      })),
    ),
  );
}

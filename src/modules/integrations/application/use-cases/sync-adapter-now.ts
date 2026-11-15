import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { adapterContext, withTimeout } from "@/modules/integrations/application/adapter-runs";
import { applyInboundSync, type InboundSyncResult } from "@/modules/integrations/application/inbound-sync";
import { canManageAdapters } from "@/modules/integrations/application/policies";
import { SYNC_READ_TIMEOUT_MS } from "@/modules/integrations/application/schemas";

/**
 * Reads people and allowances from an adapter and applies them for the admin's company
 * (`applyInboundSync`, recorded as the admin via `adapter_sync:<id>`). People it creates
 * wait inactive for an admin. The admin is checked before the adapter reads (which can
 * take up to {@link SYNC_READ_TIMEOUT_MS}) and again inside every write transaction, so
 * one demoted or deactivated meanwhile writes nothing more.
 *
 * Fails with `forbidden` (not, or no longer, an active admin), `not_found` (no such
 * adapter, or it syncs nothing), or whatever the apply step refuses. An adapter that
 * fails or times out while reading throws its own error, which the caller logs.
 */
export async function syncAdapterNow(ctx: ServiceContext, actor: Actor, adapterId: string): Promise<ServiceResult<InboundSyncResult>> {
  if (!canManageAdapters(actor)) return err("forbidden");
  return attempt(async () => {
    await assertActiveAdmin(ctx.db, actor);
    const adapter = ctx.adapters.get(adapterId);
    if (!adapter || !(adapter.syncUsers || adapter.syncBalances)) throw new DomainError("not_found");

    const actx = adapterContext(ctx, actor.companyId, SYNC_READ_TIMEOUT_MS);
    const [users, balances] = await Promise.all([
      adapter.syncUsers ? withTimeout(adapter.syncUsers(actx), actx.signal) : Promise.resolve([]),
      adapter.syncBalances ? withTimeout(adapter.syncBalances(actx), actx.signal) : Promise.resolve([]),
    ]);
    const result = await applyInboundSync(ctx, { companyId: actor.companyId, adapterId: adapter.id, trigger: { kind: "admin", actor }, users, balances });
    log.info(
      {
        adapterId: adapter.id,
        usersCreated: result.users.created,
        usersUpdated: result.users.updated,
        usersSkipped: result.users.skipped.length,
        balancesChanged: result.balances.changed,
        balancesSkipped: result.balances.skipped.length,
      },
      "adapter_sync_applied",
    );
    return result;
  });
}

/**
 * Admin use cases for registered integration adapters: list them with their health, and
 * run an inbound sync now. v1 registers none, so the Connectors screen shows an empty
 * state.
 */
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { DomainError } from "@/domain/errors";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import type { Adapter, AdapterContext } from "@/server/integrations/adapter";
import { assertActiveAdmin } from "./admin-access";
import { applyInboundSync, type InboundSyncResult } from "./inbound-sync";

/** The longest a health check may take before the screen reports it as not responding. */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;
/** The longest an adapter may take to read people or allowances for a sync. */
export const SYNC_READ_TIMEOUT_MS = 60_000;

export interface AdapterSummary {
  id: string;
  displayName: string;
  ok: boolean;
  detail: string | null;
  /** Whether it reads people or allowances, so "Sync now" applies. */
  syncs: boolean;
}

function adapterContext(ctx: ServiceContext, companyId: string, timeoutMs: number): AdapterContext {
  return { companyId, now: ctx.now, signal: AbortSignal.timeout(timeoutMs) };
}

async function withTimeout<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
  ]);
}

async function health(ctx: ServiceContext, adapter: Adapter, companyId: string): Promise<Pick<AdapterSummary, "ok" | "detail">> {
  const actx = adapterContext(ctx, companyId, HEALTH_CHECK_TIMEOUT_MS);
  try {
    const h = await withTimeout(adapter.healthCheck(actx), actx.signal);
    return { ok: h.ok === true, detail: h.detail?.slice(0, 200) ?? null };
  } catch (err) {
    log.warn({ adapterId: adapter.id, err }, "adapter_health_check_failed");
    return { ok: false, detail: actx.signal.aborted ? "Not responding." : "The health check failed." };
  }
}

/**
 * Every registered adapter with its health, checked now (in parallel, each bounded by
 * {@link HEALTH_CHECK_TIMEOUT_MS}). Empty in v1.
 *
 * @throws DomainError `forbidden`.
 */
export async function listAdapters(ctx: ServiceContext, actor: Actor): Promise<AdapterSummary[]> {
  assertCanAdminister(actor);
  return Promise.all(
    ctx.adapters.list().map(async (adapter) => ({
      id: adapter.id,
      displayName: adapter.displayName,
      syncs: Boolean(adapter.syncUsers || adapter.syncBalances),
      ...(await health(ctx, adapter, actor.companyId)),
    })),
  );
}

/**
 * Reads people and allowances from an adapter and applies them for the admin's company
 * (`applyInboundSync`, recorded as the admin via `adapter_sync:<id>`). People it creates wait inactive for an admin.
 * The admin is checked before the adapter reads (which can take up to
 * {@link SYNC_READ_TIMEOUT_MS}) and again inside every write transaction, so one demoted
 * or deactivated meanwhile writes nothing more.
 *
 * @throws DomainError `forbidden` (not, or no longer, an active admin), `not_found` (no such adapter, or
 *   it syncs nothing), or whatever the apply step throws. An adapter that fails or times
 *   out while reading throws its own error, which the caller logs.
 */
export async function syncAdapterNow(ctx: ServiceContext, actor: Actor, adapterId: string): Promise<InboundSyncResult> {
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
}

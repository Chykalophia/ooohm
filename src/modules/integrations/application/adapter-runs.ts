import "server-only";
/** How the adapter use cases call an adapter: with a context, under a time limit. */
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import type { Adapter, AdapterContext } from "@/server/integrations/adapter";
import type { AdapterSummary } from "@/modules/integrations/application/dto";
import { HEALTH_CHECK_TIMEOUT_MS } from "@/modules/integrations/application/schemas";

export function adapterContext(ctx: ServiceContext, companyId: string, timeoutMs: number): AdapterContext {
  return { companyId, now: ctx.now, signal: AbortSignal.timeout(timeoutMs) };
}

/** `work`, or a rejection once `signal` aborts, whichever comes first. */
export async function withTimeout<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
  ]);
}

/** One adapter's health, bounded by {@link HEALTH_CHECK_TIMEOUT_MS}. A failure reads as not ok, never throws. */
export async function adapterHealth(ctx: ServiceContext, adapter: Adapter, companyId: string): Promise<Pick<AdapterSummary, "ok" | "detail">> {
  const actx = adapterContext(ctx, companyId, HEALTH_CHECK_TIMEOUT_MS);
  try {
    const h = await withTimeout(adapter.healthCheck(actx), actx.signal);
    return { ok: h.ok === true, detail: h.detail?.slice(0, 200) ?? null };
  } catch (err) {
    log.warn({ adapterId: adapter.id, err }, "adapter_health_check_failed");
    return { ok: false, detail: actx.signal.aborted ? "Not responding." : "The health check failed." };
  }
}

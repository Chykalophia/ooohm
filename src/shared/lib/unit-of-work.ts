import "server-only";
import type { Transaction } from "@/db/types";
import type { ServiceContext } from "@/server/context";
import { wroteOutboxEvents } from "@/shared/lib/db/change-log";

/**
 * Runs `work` in a transaction and, once it has committed, wakes the background work
 * (`ctx.wake`, through `defer`) if the transaction wrote outbox events. The one
 * transaction entry point for services that record changes, so in `inline` mode every
 * change's webhooks go out right after the response, with no worker. A rolled-back
 * transaction wakes nothing.
 */
export async function inTransaction<T>(ctx: ServiceContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return commitThen(ctx, work, (value) => value);
}

/**
 * Runs `work` in a transaction, then hands its value to `afterCommit` (which must not
 * throw), then wakes the background work as {@link inTransaction} does. `afterCommit`
 * runs before the wake, so what it starts (an email) does not wait behind a webhook.
 * `commitThenNotify` (`@/modules/notifications`) is built on it.
 */
export async function commitThen<V, T>(ctx: ServiceContext, work: (tx: Transaction) => Promise<V>, afterCommit: (value: V) => T): Promise<T> {
  let wrote = false;
  const value = await ctx.db.transaction(async (tx) => {
    const result = await work(tx);
    wrote = wroteOutboxEvents(tx);
    return result;
  });
  const result = afterCommit(value);
  if (wrote) wakeAfterCommit(ctx);
  return result;
}

function wakeAfterCommit(ctx: ServiceContext): void {
  const wake = ctx.wake;
  if (wake) ctx.defer(wake);
}

import type { Transaction } from "@/db/types";
import type { ServiceContext } from "@/server/context";
import type { Notification } from "@/server/notifications/catalog";
import { sendAfterCommit } from "@/server/notifications/send";
import { wroteOutboxEvents } from "@/server/repositories/change-log";

export type { Notification } from "@/server/notifications/catalog";

/**
 * Runs `work` in a transaction and, once it has committed, wakes the background work
 * (`ctx.wake`, through `defer`) if the transaction wrote outbox events. The one
 * transaction entry point for services that record changes, so in `inline` mode every
 * change's webhooks go out right after the response, with no worker. A rolled-back
 * transaction wakes nothing.
 */
export async function inTransaction<T>(ctx: ServiceContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
  const { result, wrote } = await transact(ctx, work);
  if (wrote) wakeAfterCommit(ctx);
  return result;
}

async function transact<T>(ctx: ServiceContext, work: (tx: Transaction) => Promise<T>): Promise<{ result: T; wrote: boolean }> {
  let wrote = false;
  const result = await ctx.db.transaction(async (tx) => {
    const value = await work(tx);
    wrote = wroteOutboxEvents(tx);
    return value;
  });
  return { result, wrote };
}

function wakeAfterCommit(ctx: ServiceContext): void {
  const wake = ctx.wake;
  if (wake) ctx.defer(wake);
}

/**
 * Runs `work` in a transaction ({@link inTransaction}), then sends the notifications it
 * returned, all about `companyId` (whose accent they take). The only way services send
 * mail: ordering is fixed here, so no service can email about a change that later rolls
 * back. See `src/server/notifications` for the types and how each is built and sent.
 */
export async function commitThenNotify<T>(
  ctx: ServiceContext,
  companyId: string,
  work: (tx: Transaction) => Promise<{ result: T; notify: readonly Notification[] }>,
): Promise<T> {
  const {
    result: { result, notify },
    wrote,
  } = await transact(ctx, work);
  // Emails first: a sign-in or decision email should not wait behind a webhook timeout.
  sendAfterCommit(ctx, companyId, notify);
  if (wrote) wakeAfterCommit(ctx);
  return result;
}

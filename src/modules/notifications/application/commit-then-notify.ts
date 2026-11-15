import "server-only";
import type { Transaction } from "@/db/types";
import type { ServiceContext } from "@/server/context";
import { forTenant } from "@/shared/lib/tenant";
import { commitThen } from "@/shared/lib/unit-of-work";
import type { Notification } from "./catalog";
import { sendAfterCommit } from "./send";

/**
 * Runs `work` in a transaction of `companyId` (`inTransaction`, `@/shared/lib/unit-of-work`,
 * with `ctx` scoped to the company by `forTenant`), then sends the notifications it
 * returned, all about `companyId` (whose accent they take). The only way services send
 * mail: ordering is fixed here, so no service can email about a change that later rolls
 * back. See `catalog.ts` for the types and how each is built and sent.
 */
export async function commitThenNotify<T>(
  ctx: ServiceContext,
  companyId: string,
  work: (tx: Transaction) => Promise<{ result: T; notify: readonly Notification[] }>,
): Promise<T> {
  const scoped = forTenant(ctx, companyId);
  // Emails first: a sign-in or decision email should not wait behind a webhook timeout.
  return commitThen(scoped, companyId, work, ({ result, notify }) => {
    sendAfterCommit(scoped, companyId, notify);
    return result;
  });
}

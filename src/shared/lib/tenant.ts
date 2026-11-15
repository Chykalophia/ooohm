import "server-only";
import { switchTenantWithin, tenantDatabase } from "@/db/tenant";
import type { Transaction } from "@/db/types";
import type { ServiceContext } from "@/server/context";

/**
 * The service context for one company's rows (ADR-0004): `ctx` with its database bound to
 * `companyId`, so every transaction and read it runs sets the tenant row-level security
 * checks (`src/db/tenant.ts`). Use cases and queries call it first, with the company of
 * their actor or API key (never one from input); `inTransaction` and `commitThenNotify`
 * then run in that company, and so does every read through `ctx.db`.
 *
 * Without it, `ctx.db` shows no company's rows and writes none: only the pre-tenant
 * lookups (`src/shared/lib/db/pre-tenant.ts`) and the tables without a tenant work there.
 *
 * @throws Error when `ctx` is already scoped to another company: a service never acts for
 *   two companies at once.
 */
export function forTenant<C extends ServiceContext>(ctx: C, companyId: string): C {
  if (ctx.tenant === companyId) return ctx;
  if (ctx.tenant !== undefined) throw new Error("This service context is scoped to another company.");
  // Bound on first use, so a call refused on its input never touches the database.
  let db: ServiceContext["db"] | undefined;
  const scoped = { ...ctx, tenant: companyId };
  Object.defineProperty(scoped, "db", { enumerable: true, get: () => (db ??= tenantDatabase(ctx.db, companyId)) });
  return scoped;
}

/**
 * Runs `work` in one transaction for `companyId`: for reads that belong together (one
 * snapshot, one connection). Changes go through `inTransaction` or `commitThenNotify`.
 */
export function withTenant<T>(ctx: ServiceContext, companyId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return forTenant(ctx, companyId).db.transaction(work);
}

/**
 * Runs `work` inside `tx` (a transaction for `from`) for company `to`, then back: only
 * for recording a person's own calendar link revoke in the company the link belonged to
 * (`src/modules/calendar/application/feed-changes.ts`).
 */
export function recordInCompanyWithin<T>(tx: Transaction, from: string, to: string, work: () => Promise<T>): Promise<T> {
  return switchTenantWithin(tx, from, to, work);
}

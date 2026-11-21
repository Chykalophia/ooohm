import "server-only";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { isUuid } from "@/shared/kernel/uuid";
import * as schema from "./schema";
import type { Database, Transaction } from "./types";

/**
 * Row-level security's tenant (ADR-0004, drizzle/0031_row_level_security.sql). Every
 * company-scoped table shows and takes only the rows of the company named by the
 * transaction-local setting `app.company_id`; without it, none.
 *
 * {@link tenantDatabase} turns a handle into one bound to a company: every transaction it
 * opens starts with `set_config('app.company_id', <id>, true)`, and every statement run
 * outside one runs in a transaction of its own that does. The setting is transaction-local,
 * so it never outlives the transaction and is safe behind a transaction pooler (Neon's
 * PgBouncer), and nothing a request does can leave it set for the next one.
 *
 * It costs no extra round trip: on Postgres the setting is pipelined with the statement
 * after it, and a statement on its own is sent as `begin; set; statement; commit` in one
 * flight. Embedded PGlite runs in process.
 *
 * The setting is set below drizzle, so it never shows in a query log or a query count.
 * Services reach this through `forTenant` (`@/shared/lib/tenant`); nothing else should.
 */

/** The setting the policies read, through `ooohm_tenant()`. */
export const TENANT_SETTING = "app.company_id";

const SET_TENANT = `select set_config('${TENANT_SETTING}', $1, true)`;

/** The role embedded PGlite's app handle acts as, so the policies hold there too (PGlite's own user is a superuser). */
export const EMBEDDED_APP_ROLE = "ooohm_app";

const SET_ROLE = "select set_config('role', $1, true)";

/** Builds a handle bound to one company. */
type TenantFactory = (companyId: string) => Database;

/**
 * Kept on `globalThis`, like the database handle itself (`src/db/index.ts`): Next.js may load
 * this file into more than one module graph (instrumentation, route bundles), and a handle
 * registered in one must bind in all.
 */
const registry = ((globalThis as unknown as { ooohmTenantRegistry?: { factories: WeakMap<Database, TenantFactory>; tenants: WeakMap<Database, string> } })
  .ooohmTenantRegistry ??= { factories: new WeakMap(), tenants: new WeakMap() });
const { factories, tenants } = registry;

/** How many company-bound handles each handle keeps for reuse. */
const CACHE_SIZE = 256;

/**
 * Registers how `db` makes company-bound handles. `src/db/connect.ts` does it for every
 * handle it opens (and tests' harness for theirs); {@link tenantDatabase} binds no others.
 */
export function registerTenantFactory(db: Database, make: TenantFactory): Database {
  const cache = new Map<string, Database>();
  factories.set(db, (companyId) => {
    const hit = cache.get(companyId);
    if (hit) return hit;
    const bound = make(companyId);
    tenants.set(bound, companyId);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    cache.set(companyId, bound);
    return bound;
  });
  return db;
}

/**
 * `db`, bound to the company `companyId`: what every service reads and writes tenant rows
 * through. A handle already bound to that company is returned as is.
 *
 * A handle this cannot bind (a unit test's stand-in: not opened through
 * `src/db/connect.ts`, nor on a postgres.js client) is returned as is; a real one would
 * act with no tenant, which the policies answer with no rows.
 *
 * @throws Error when `companyId` is not a company id, or when `db` is bound to another company.
 */
export function tenantDatabase(db: Database, companyId: string): Database {
  const bound = tenants.get(db);
  if (bound !== undefined) {
    if (bound === companyId) return db;
    throw new Error("This database handle is bound to another company.");
  }
  let make = factories.get(db);
  if (!make) {
    // A plain drizzle handle on a postgres.js client (a script's or a test's own): bind it
    // the same way, without a logger.
    const client = (db as unknown as { $client?: unknown }).$client;
    if (!isPostgresClient(client)) return db;
    registerTenantFactory(db, (id) => drizzle({ client: postgresTenantClient(client, id), schema, casing: "snake_case" }));
    make = factories.get(db)!;
  }
  if (!isUuid(companyId)) throw new Error("A tenant is a company id (a UUID).");
  return make(companyId);
}

function isPostgresClient(client: unknown): client is postgres.Sql {
  return typeof client === "function" && typeof (client as { unsafe?: unknown }).unsafe === "function" && typeof (client as { reserve?: unknown }).reserve === "function";
}

/** The company `db` is bound to, or `undefined` for a handle that is not. */
export function tenantOf(db: Database): string | undefined {
  return tenants.get(db);
}

/**
 * A postgres.js client whose transactions and statements run for `companyId`. Drizzle runs
 * on it as on any client: it calls only `unsafe` (statements) and `begin` (transactions),
 * and reads `options`.
 */
export function postgresTenantClient(base: postgres.Sql, companyId: string): postgres.Sql {
  const client = {
    options: base.options,
    unsafe(query: string, params?: unknown[], options?: object) {
      return pendingStatement((asValues) => statementForTenant(base, companyId, query, params ?? [], options ?? {}, asValues));
    },
    begin(work: (tx: postgres.TransactionSql) => unknown) {
      return base.begin((tx) => {
        // Sent before anything `work` sends, on the same connection, without waiting.
        const setting = tx.unsafe(SET_TENANT, [companyId]);
        setting.catch(() => {});
        return Promise.resolve(work(tx)).then(async (value) => {
          await setting;
          return value;
        });
      });
    },
  };
  return client as unknown as postgres.Sql;
}

/** One statement in a transaction of its own for the tenant, sent in one flight. */
async function statementForTenant(
  base: postgres.Sql,
  companyId: string,
  query: string,
  params: unknown[],
  options: object,
  asValues: boolean,
): Promise<unknown> {
  const conn = await base.reserve();
  try {
    const main = conn.unsafe(query, params as postgres.ParameterOrJSON<never>[], options);
    if (asValues) main.values();
    // Promise.allSettled starts them in order, so they go out in order on the reserved
    // connection without waiting for each other. A failed statement turns the commit
    // into a rollback, so the connection goes back clean either way.
    const [begin, setting, result, commit] = await Promise.allSettled([conn.unsafe("begin"), conn.unsafe(SET_TENANT, [companyId]), main, conn.unsafe("commit")]);
    const failed = [begin, setting, result, commit].find((r) => r.status === "rejected");
    if (failed) {
      if (commit.status === "rejected") await conn.unsafe("rollback").catch(() => {});
      throw failed.reason;
    }
    return (result as PromiseFulfilledResult<unknown>).value;
  } finally {
    conn.release();
  }
}

/** A statement drizzle can `await` (objects) or ask `.values()` of (arrays), run once on demand. */
function pendingStatement(run: (asValues: boolean) => Promise<unknown>) {
  let asValues = false;
  let started: Promise<unknown> | undefined;
  const start = () => (started ??= run(asValues));
  return {
    values() {
      asValues = true;
      return start();
    },
    then<A, B>(onFulfilled?: (value: unknown) => A | PromiseLike<A>, onRejected?: (reason: unknown) => B | PromiseLike<B>) {
      return start().then(onFulfilled, onRejected);
    },
    catch<B>(onRejected?: (reason: unknown) => B | PromiseLike<B>) {
      return start().catch(onRejected);
    },
  };
}

/** What drizzle's PGlite driver calls on its client. */
export interface EmbeddedClientLike extends EmbeddedTransactionLike {
  transaction<T>(work: (tx: EmbeddedTransactionLike) => Promise<T>): Promise<T>;
}

/** What drizzle's PGlite driver calls inside a transaction. */
export interface EmbeddedTransactionLike {
  query(query: string, params?: unknown[], options?: object): Promise<unknown>;
}

/** Wraps every PGlite statement and transaction so it first runs `prepare` inside the transaction. */
function preparedEmbeddedClient(base: EmbeddedClientLike, prepare: (tx: EmbeddedTransactionLike) => Promise<unknown>): EmbeddedClientLike {
  return {
    query: (query, params, options) =>
      base.transaction(async (tx) => {
        await prepare(tx);
        return tx.query(query, params, options);
      }),
    transaction: (work) =>
      base.transaction(async (tx) => {
        await prepare(tx);
        return work(tx);
      }),
  };
}

/** A PGlite client whose transactions and statements run for `companyId`. */
export function embeddedTenantClient(base: EmbeddedClientLike, companyId: string): EmbeddedClientLike {
  return preparedEmbeddedClient(base, (tx) => tx.query(SET_TENANT, [companyId]));
}

/**
 * A PGlite client whose every transaction and statement runs as `role` (`SET LOCAL ROLE`),
 * so embedded mode's app handle is held to the policies like the app role on Postgres.
 * PGlite has one connection and a superuser; this guards against a forgotten tenant, not
 * against code in the same process that switches the role back on purpose.
 */
export function embeddedRoleClient(base: EmbeddedClientLike, role: string = EMBEDDED_APP_ROLE): EmbeddedClientLike {
  return preparedEmbeddedClient(base, (tx) => tx.query(SET_ROLE, [role]));
}

/**
 * The company a transaction switched from ({@link switchTenantWithin}), read by
 * `ooohm_acting_company()`: the audit log may name its people too (drizzle/0032).
 */
export const ACTING_COMPANY_SETTING = "app.acting_company_id";

/**
 * Runs `work` inside `tx`, a transaction for company `from`, for company `to` (with `from`
 * as the acting company), then switches back, whether `work` succeeds or throws. For the
 * one change that spans companies by design: a person's own calendar link from a company
 * they have left is turned off from their new one, and the revoke is recorded in the
 * company the link belonged to. Called only from there
 * (tests/architecture/row-level-security.test.ts).
 *
 * When `work` throws, its error is the one rethrown: switching back can then fail only
 * because the transaction is aborted, and an aborted transaction runs nothing more.
 */
export async function switchTenantWithin<T>(tx: Transaction, from: string, to: string, work: () => Promise<T>): Promise<T> {
  if (!isUuid(from) || !isUuid(to)) throw new Error("A tenant is a company id.");
  if (from === to) return work();
  await tx.execute(sql`select set_config(${TENANT_SETTING}, ${to}, true), set_config(${ACTING_COMPANY_SETTING}, ${from}, true)`);
  const switchBack = () => tx.execute(sql`select set_config(${TENANT_SETTING}, ${from}, true), set_config(${ACTING_COMPANY_SETTING}, ${""}, true)`);
  let result: T;
  try {
    result = await work();
  } catch (err) {
    await switchBack().catch(() => undefined);
    throw err;
  }
  await switchBack();
  return result;
}

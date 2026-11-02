import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Database handle types, kept apart from `./index` so that code which only needs the
 * types (repositories, services, tests) does not open the app's connection pool or
 * load its environment.
 *
 * The handle is driver-neutral: a Postgres server through postgres.js, or embedded
 * PGlite (`./connect`). Everything that goes through the query builder behaves the
 * same on both. What a raw `execute(sql)` returns differs by driver, so repositories
 * use the query builder (with `.returning()` where they need rows back) instead.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The handle passed to a `db.transaction(async (tx) => ...)` callback. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Anything a repository can run a query on: the pool or an open transaction. */
export type Executor = Database | Transaction;

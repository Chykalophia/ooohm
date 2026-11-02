import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "./schema";

/**
 * Database handle types, kept apart from `./index` so that code which only needs the
 * types (repositories, services, tests) does not open the app's connection pool or
 * load its environment.
 */
export type Database = PostgresJsDatabase<typeof schema>;

/** The handle passed to a `db.transaction(async (tx) => ...)` callback. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Anything a repository can run a query on: the pool or an open transaction. */
export type Executor = Database | Transaction;

import "server-only";
import { env } from "@/lib/env";
import { connectPostgres, type DatabaseHandle, type EmbeddedClient, embeddedAppDatabase, migrateDatabase, openEmbedded } from "./connect";
import * as schema from "./schema";
import { registerTenantFactory, tenantDatabase } from "./tenant";
import type { Database } from "./types";

/**
 * The app's database handle.
 *
 * With Postgres it is a postgres.js pool, created at once (it connects on first query).
 * In embedded mode PGlite has to be opened, locked and migrated asynchronously, which
 * `instrumentation.ts` does before the server takes a request ({@link openAppDatabase});
 * until then `db` refuses with a clear error. The live handle sits on `globalThis` so
 * that every module graph in the process (and hot reloads in development) shares one.
 */
const globalForDb = globalThis as unknown as { ooohmDb?: DatabaseHandle; ooohmAppDb?: Database; ooohmDbOpening?: Promise<DatabaseHandle> };

/** The embedded app's handle: PGlite, acting as the app role so row-level security holds (`embeddedAppDatabase`). */
function embeddedDb(): Database {
  const db = globalForDb.ooohmAppDb;
  if (!db) {
    throw new Error("The embedded database is not open yet. It opens when the server starts (src/instrumentation.ts).");
  }
  return db;
}

function postgresDb(): Database {
  if (env.database.kind !== "postgres") throw new Error("unreachable");
  const handle = globalForDb.ooohmDb ?? connectPostgres(env.database);
  if (process.env.NODE_ENV !== "production") globalForDb.ooohmDb = handle;
  return handle.db;
}

/** Forwards every property to the embedded handle, once it is open. */
const embeddedProxy = new Proxy({} as Database, {
  get(_, prop) {
    const real = embeddedDb();
    const value = Reflect.get(real, prop, real) as unknown;
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export const db: Database =
  env.database.kind === "postgres" ? postgresDb() : registerTenantFactory(embeddedProxy, (companyId) => tenantDatabase(embeddedDb(), companyId));

/** Which kind of database the app runs on: `postgres` or `embedded`. */
export const databaseKind = env.database.kind;

/**
 * Opens the embedded database for this process: takes the directory lock, then applies
 * pending migrations. Idempotent; concurrent callers share one opening. A no-op with
 * Postgres, whose migrations run as their own step (`pnpm db:migrate`, the compose
 * `migrate` service, the Vercel production build).
 */
export async function openAppDatabase(): Promise<void> {
  const config = env.database;
  if (config.kind !== "embedded" || globalForDb.ooohmDb) return;
  globalForDb.ooohmDbOpening ??= (async () => {
    const handle = await openEmbedded(config, { purpose: "the app" });
    await migrateDatabase(config, { embedded: handle });
    globalForDb.ooohmAppDb = await embeddedAppDatabase(handle as DatabaseHandle & { client: EmbeddedClient });
    globalForDb.ooohmDb = handle;
    return handle;
  })();
  await globalForDb.ooohmDbOpening;
}

export { schema };

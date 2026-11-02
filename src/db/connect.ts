import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Logger } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { DatabaseConfig, EmbeddedConfig, PostgresConfig } from "./config";
import { acquireEmbeddedLock } from "./embedded-lock";
import * as schema from "./schema";
import type { Database } from "./types";

/**
 * Opens the configured database for a process. The app (`./index`), the scripts, the
 * worker and the tests all come through here, so every one of them gets the same pooler,
 * pool-size and embedded-mode handling.
 *
 * PGlite is imported only when embedded mode is selected, so the Postgres path never
 * loads it.
 */

export interface DatabaseHandle {
  db: Database;
  kind: DatabaseConfig["kind"];
  /** Closes the pool (or the embedded database) and, for embedded mode, releases the directory lock. */
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Named in the embedded lock, so another process can say who holds the directory. */
  purpose: string;
  /** Overrides the configured pool size (scripts need one or two connections). */
  max?: number;
  logger?: Logger;
}

/** The drizzle options every handle shares. */
function drizzleOptions(logger?: Logger) {
  return { schema, casing: "snake_case" as const, ...(logger ? { logger } : {}) };
}

/** A postgres.js pool for `url` with the configured pooler and serverless settings. Connects lazily. */
export function postgresClient(config: PostgresConfig, options: { url?: string; max?: number } = {}) {
  return postgres(options.url ?? config.url, {
    max: options.max ?? config.max,
    prepare: config.prepare,
    onnotice: () => {},
    ...(config.idleTimeout === undefined ? {} : { idle_timeout: config.idleTimeout }),
  });
}

/** A Postgres-backed handle. Synchronous: nothing connects until the first query. */
export function connectPostgres(config: PostgresConfig, options: Omit<OpenOptions, "purpose"> & { url?: string } = {}): DatabaseHandle & { client: postgres.Sql } {
  const client = postgresClient(config, options);
  return {
    db: drizzle(client, drizzleOptions(options.logger)),
    client,
    kind: "postgres",
    close: () => client.end({ timeout: 5 }),
  };
}

/** The PGlite instance behind an embedded handle, for tests that need it directly. */
export type EmbeddedClient = import("@electric-sql/pglite").PGlite;

/**
 * Loads PGlite and drizzle's driver and migrator for it, at run time. `webpackIgnore`
 * keeps all three out of the Next.js bundle and its traced output, so the Docker image
 * and Vercel functions never carry PGlite's ~20 MB. Embedded mode runs from a checkout
 * (`pnpm start:embedded`), where Node resolves them from node_modules.
 */
async function loadPglite() {
  const [pglite, driver, migrator] = await Promise.all([
    import(/* webpackIgnore: true */ "@electric-sql/pglite"),
    import(/* webpackIgnore: true */ "drizzle-orm/pglite"),
    import(/* webpackIgnore: true */ "drizzle-orm/pglite/migrator"),
  ]);
  return { PGlite: pglite.PGlite, drizzlePglite: driver.drizzle, migrate: migrator.migrate };
}

/**
 * Opens (creating it if needed) the embedded database, after taking its directory lock.
 * `dataDir: "memory"` opens a throwaway in-memory database with no lock.
 *
 * @throws Error when another process holds the directory, or on a serverless host,
 *   whose filesystem does not outlive a request.
 */
export async function openEmbedded(config: EmbeddedConfig, options: OpenOptions): Promise<DatabaseHandle & { client: EmbeddedClient }> {
  if (process.env.VERCEL) {
    throw new Error("Embedded mode needs a disk that persists, so it cannot run on Vercel. Set DATABASE_URL to a Postgres database (e.g. Neon).");
  }
  const memory = config.dataDir === "memory";
  const lock = memory ? null : acquireEmbeddedLock(config.dataDir, options.purpose);
  try {
    const { PGlite, drizzlePglite } = await loadPglite();
    let client: EmbeddedClient;
    if (memory) {
      client = await PGlite.create();
    } else {
      const dir = path.resolve(config.dataDir);
      mkdirSync(dir, { recursive: true });
      client = await PGlite.create(dir);
    }
    const db = drizzlePglite(client, drizzleOptions(options.logger)) as unknown as Database;
    return {
      db,
      client,
      kind: "embedded",
      async close() {
        try {
          await client.close();
        } finally {
          lock?.release();
        }
      },
    };
  } catch (err) {
    lock?.release();
    throw err;
  }
}

/** Opens whichever database `config` names. */
export async function openDatabase(config: DatabaseConfig, options: OpenOptions): Promise<DatabaseHandle> {
  return config.kind === "embedded" ? openEmbedded(config, options) : connectPostgres(config, options);
}

/** Where the app's migrations live; scripts and tests run from the repository root. */
export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");

/**
 * Applies pending migrations. Postgres migrates over `migrationUrl` (`DATABASE_URL_UNPOOLED`
 * when set) on a connection of its own, since DDL and the migrator need a real session
 * rather than a transaction pooler. Embedded mode migrates the handle it is given.
 */
export async function migrateDatabase(
  config: DatabaseConfig,
  options: { embedded?: DatabaseHandle; migrationsFolder?: string; purpose?: string } = {},
): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  if (config.kind === "postgres") {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    // A direct connection: prepared statements are fine there even when the app's pool is pooled.
    const direct = { ...config, prepare: config.migrationUrl !== config.url || config.prepare };
    const handle = connectPostgres(direct, { url: config.migrationUrl, max: 1 });
    try {
      await migrate(drizzle(handle.client), { migrationsFolder });
    } finally {
      await handle.close();
    }
    return;
  }
  const handle = options.embedded ?? (await openEmbedded(config, { purpose: options.purpose ?? "migrations" }));
  try {
    const { migrate, drizzlePglite } = await loadPglite();
    await migrate(drizzlePglite((handle as DatabaseHandle & { client: EmbeddedClient }).client), { migrationsFolder });
  } finally {
    if (!options.embedded) await handle.close();
  }
}

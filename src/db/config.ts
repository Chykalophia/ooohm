import "server-only";
/**
 * Which database OOOhm talks to, decided from the environment in one place.
 *
 * - **Postgres** (`DATABASE_URL=postgres://...`): any Postgres 15 or later: a server of
 *   your own, the compose `db` service, Neon, Supabase, RDS. `sslmode` and the other
 *   query parameters in the URL are honoured by the driver.
 * - **Embedded** (`OOOHM_DB=embedded`, or `DATABASE_URL=pglite:<dir>`): PGlite, Postgres
 *   compiled to WebAssembly, storing its files in a directory. No database server, one
 *   process only.
 *
 * Two roles share a Postgres database (ADR-0006): the app, the cron route and the worker
 * connect as the app role (`DATABASE_URL`, {@link resolveDatabaseConfig}); migrations, the
 * seed and the TimeOff import connect as the owner (`DATABASE_ADMIN_URL`,
 * {@link resolveAdminDatabaseConfig}, opened only by `src/server/admin/db.ts`). Embedded
 * PGlite has one built-in user, so both resolve to its single handle.
 *
 * Pure: it reads the record it is given, so it can be tested and reused by scripts that
 * do not load the app's environment.
 */

export type DatabaseConfig = PostgresConfig | EmbeddedConfig;

export interface PostgresConfig {
  kind: "postgres";
  /** What the app, the worker and the jobs connect with (pooled, when the host offers a pooler). */
  url: string;
  /**
   * The connection migrations run over. For the owner's config
   * ({@link resolveAdminDatabaseConfig}) it is `DATABASE_ADMIN_URL`, the URL migrations use.
   * The app's config carries `DATABASE_URL_UNPOOLED` here (else `url`), which nothing
   * migrates with any more: the app role cannot run DDL.
   */
  migrationUrl: string;
  /**
   * Whether the driver may use named prepared statements. False behind a transaction
   * pooler (PgBouncer in transaction mode, Supavisor on 6543, Neon's `-pooler` host),
   * which hands each transaction a different server connection.
   */
  prepare: boolean;
  /** Most connections this process opens. Small on serverless hosts, where every instance has its own pool. */
  max: number;
  /** Seconds before an idle connection is closed; set on serverless hosts so frozen instances let go. */
  idleTimeout: number | undefined;
}

export interface EmbeddedConfig {
  kind: "embedded";
  /** The directory PGlite keeps its files in, or `memory` for a throwaway in-memory database (tests). */
  dataDir: string;
}

/** Where embedded mode keeps its data unless told otherwise. */
export const DEFAULT_EMBEDDED_DIR = "./data/pglite";

/** The `DATABASE_URL` scheme that selects embedded mode: `pglite:./data/ooohm`, or `pglite:memory`. */
export const PGLITE_SCHEME = "pglite:";

const POOL_MAX = 10;
const SERVERLESS_POOL_MAX = 3;
const SERVERLESS_IDLE_SECONDS = 20;

type Env = Record<string, string | undefined>;

function value(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

/** Whether this process runs on a serverless host (Vercel sets `VERCEL=1`). */
export function isServerless(env: Env): boolean {
  return value(env, "VERCEL") !== undefined || value(env, "DATABASE_SERVERLESS") === "true";
}

/**
 * Whether `url` goes through a transaction pooler, where prepared statements break:
 * `DATABASE_POOLER=transaction` says so explicitly (`session` or `none` says it does
 * not); otherwise a Neon `-pooler` host or Supabase's pooler port 6543.
 */
export function usesTransactionPooler(url: string, pooler?: string): boolean {
  if (pooler === "transaction") return true;
  if (pooler === "session" || pooler === "none") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if ((parsed.hostname.split(".")[0] ?? "").endsWith("-pooler")) return true;
  return parsed.port === "6543";
}

/**
 * Reads the database settings: `OOOHM_DB`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
 * `DATABASE_POOLER`, `DATABASE_POOL_MAX`, `DATABASE_SERVERLESS`, `VERCEL` and
 * `OOOHM_DATA_DIR`.
 *
 * @throws Error with a readable message when nothing usable is configured.
 */
export function resolveDatabaseConfig(env: Env): DatabaseConfig {
  const url = value(env, "DATABASE_URL");
  const mode = value(env, "OOOHM_DB");
  if (mode !== undefined && mode !== "embedded" && mode !== "postgres") {
    throw new Error(`OOOHM_DB must be "embedded" or "postgres" (got "${mode}").`);
  }
  // OOOHM_DB=embedded wins over a postgres:// DATABASE_URL left in .env: the switch is the
  // deliberate choice (`pnpm start:embedded` sets it).
  if (mode === "embedded" || (mode === undefined && url?.startsWith(PGLITE_SCHEME))) {
    const fromUrl = url?.startsWith(PGLITE_SCHEME) ? url.slice(PGLITE_SCHEME.length).replace(/^\/\//, "") : "";
    return { kind: "embedded", dataDir: fromUrl || value(env, "OOOHM_DATA_DIR") || DEFAULT_EMBEDDED_DIR };
  }
  if (url?.startsWith(PGLITE_SCHEME)) throw new Error("OOOHM_DB=postgres needs a postgres:// DATABASE_URL, not pglite:.");
  if (!url) throw new Error("DATABASE_URL is not set. Set it to a Postgres URL, or set OOOHM_DB=embedded to run without a database server.");
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("DATABASE_URL must start with postgres:// or postgresql:// (or pglite: for embedded mode).");

  const serverless = isServerless(env);
  const maxRaw = value(env, "DATABASE_POOL_MAX");
  const max = maxRaw === undefined ? (serverless ? SERVERLESS_POOL_MAX : POOL_MAX) : Number(maxRaw);
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error("DATABASE_POOL_MAX must be a whole number from 1 to 100.");
  const pooler = value(env, "DATABASE_POOLER");
  if (pooler !== undefined && !["transaction", "session", "none"].includes(pooler)) {
    throw new Error(`DATABASE_POOLER must be "transaction", "session" or "none" (got "${pooler}").`);
  }
  return {
    kind: "postgres",
    url,
    migrationUrl: value(env, "DATABASE_URL_UNPOOLED") ?? url,
    prepare: !usesTransactionPooler(url, pooler),
    max,
    idleTimeout: serverless ? SERVERLESS_IDLE_SECONDS : undefined,
  };
}

/** Where the hosting docs explain the two database roles; error messages point there. */
export const DATABASE_ROLES_DOCS = "docs/deploy.md#database-roles";

/** Why migrate, seed or the TimeOff import refuse to run on Postgres without the owner's URL. */
export const ADMIN_URL_MISSING =
  "DATABASE_ADMIN_URL is not set. Migrations, the seed and the TimeOff import connect as the database owner role, " +
  "apart from the app's DATABASE_URL (the app role, which cannot change the schema). Set DATABASE_ADMIN_URL to the " +
  "owner role's direct (unpooled) postgres:// connection string: on Vercel with Neon, the neondb_owner URL without " +
  `"-pooler" in its host (the value DATABASE_URL_UNPOOLED holds when the Neon integration set it). See ${DATABASE_ROLES_DOCS}.`;

function isEmbedded(env: Env): boolean {
  const mode = value(env, "OOOHM_DB");
  if (mode !== undefined && mode !== "embedded" && mode !== "postgres") {
    throw new Error(`OOOHM_DB must be "embedded" or "postgres" (got "${mode}").`);
  }
  return mode === "embedded" || (mode === undefined && value(env, "DATABASE_URL")?.startsWith(PGLITE_SCHEME) === true);
}

/**
 * The owner's database, for migrations, the seed and the TimeOff import: `DATABASE_ADMIN_URL`
 * on Postgres (required; `DATABASE_URL_UNPOOLED` is not a fallback, so a deployment that has
 * not split its roles fails here instead of migrating as whatever role it has), or the same
 * single handle as the app in embedded mode. The owner's URL should be a direct connection:
 * prepared statements follow its host (a Neon `-pooler` host or port 6543 turns them off),
 * and `DATABASE_POOLER`, which describes `DATABASE_URL`, does not apply to it.
 *
 * @throws Error with {@link ADMIN_URL_MISSING} on Postgres without `DATABASE_ADMIN_URL`, or
 *   a readable message for any other unusable setting.
 */
export function resolveAdminDatabaseConfig(env: Env): DatabaseConfig {
  if (isEmbedded(env)) return resolveDatabaseConfig(env);
  const adminUrl = value(env, "DATABASE_ADMIN_URL");
  if (!adminUrl) throw new Error(ADMIN_URL_MISSING);
  if (!/^postgres(ql)?:\/\//.test(adminUrl)) throw new Error("DATABASE_ADMIN_URL must start with postgres:// or postgresql://.");
  return resolveDatabaseConfig({ ...env, OOOHM_DB: "postgres", DATABASE_URL: adminUrl, DATABASE_URL_UNPOOLED: undefined, DATABASE_POOLER: undefined });
}

/** The user name in a postgres:// URL, or `undefined` when it has none or does not parse. */
export function databaseUser(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const user = decodeURIComponent(new URL(url).username);
    return user || undefined;
  } catch {
    return undefined;
  }
}

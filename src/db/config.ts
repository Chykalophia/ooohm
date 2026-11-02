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
 * Pure: it reads the record it is given, so it can be tested and reused by scripts that
 * do not load the app's environment.
 */

export type DatabaseConfig = PostgresConfig | EmbeddedConfig;

export interface PostgresConfig {
  kind: "postgres";
  /** What the app, the worker and the jobs connect with (pooled, when the host offers a pooler). */
  url: string;
  /**
   * A direct connection for migrations: `DATABASE_URL_UNPOOLED` when set, else `url`. DDL
   * and the migrator's session state need a real session, not a transaction pooler.
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
  if (parsed.hostname.split(".")[0].endsWith("-pooler")) return true;
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

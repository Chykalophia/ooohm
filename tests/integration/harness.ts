/**
 * Integration test harness: a fresh, fully migrated database per test file.
 *
 * Set `TEST_DATABASE_URL` to any database on a server where the user may create
 * databases (e.g. `postgres://postgres:pw@127.0.0.1:55502/postgres`). Each file gets
 * its own `ooohm_test_<random>` database, so files run in parallel without sharing
 * state; it is dropped when the file finishes. Without the variable, suites skip with
 * a message instead of failing, so `pnpm test:integration` is safe to run anywhere.
 *
 * `TEST_DATABASE_URL=pglite:memory` (`pnpm test:integration:embedded`) runs the same
 * suites against embedded PGlite instead: an in-memory database per file, migrated the
 * way embedded mode migrates. The few tests that need two connections at once (one
 * holding a lock while another works) are skipped there with {@link needsServer}.
 *
 * Services run as the app role, held to row-level security (ADR-0004): on Postgres,
 * `TEST_DATABASE_URL`'s user owns each test database and a shared plain role,
 * `ooohm_test_app`, gets the app's grants; on PGlite the app handle acts as `ooohm_app`.
 * `TestDatabase.db` is the owner, for seeding and checking rows of any company;
 * {@link createTestContext} hands services the matching app handle.
 */
import { randomUUID } from "node:crypto";
import { type Logger, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { MIGRATIONS_FOLDER as APP_MIGRATIONS, embeddedDatabase, migrateDatabase, openEmbedded, postgresDatabase } from "@/db/connect";
import { executeRows } from "@/db/rows";
import { type EmbeddedClientLike, embeddedRoleClient } from "@/db/tenant";
import type { Database } from "@/db/types";
import { applyDatabaseRoles } from "@/server/admin/db";
import { STRICT_TARGET_POLICY, type TargetPolicy } from "@/shared/kernel/webhook-target";
import { createSecretBox } from "@/lib/integration-crypto";
import type { MailMessage, ServiceContext } from "@/server/context";
import { type AdapterRegistry, createAdapterRegistry } from "@/server/integrations/adapter";
import { uuidGenerator } from "@/shared/lib/id-generator";
import { wireModules } from "@/server/wiring";

wireModules();

const baseUrl = process.env.TEST_DATABASE_URL;

/** Whether this run uses embedded PGlite (`TEST_DATABASE_URL=pglite:memory`) instead of a Postgres server. */
export const embedded = baseUrl === "pglite:memory";
if (baseUrl?.startsWith("pglite:") && !embedded) throw new Error("For embedded tests set TEST_DATABASE_URL=pglite:memory.");

/** Pass as `describe(name, { skip }, ...)`: `false` when a database is configured. */
export const skip: string | false = baseUrl
  ? false
  : "TEST_DATABASE_URL is not set; skipping integration tests. See docs/architecture.md#testing.";

/**
 * Pass as `test(name, { skip: needsServer }, ...)` for a test that needs two connections
 * at once (one holds a lock or an open transaction while another works) or a server
 * feature: embedded PGlite has one connection, which runs one transaction at a time.
 */
export const needsServer: string | false = embedded ? "needs concurrent connections to a Postgres server; embedded PGlite has one" : false;

export interface TestDatabase {
  db: Database;
  /** True for embedded PGlite. */
  embedded: boolean;
  /**
   * The postgres.js pool, for tests that hold a second connection (`reserve()`) or need
   * server-only SQL. Throws on embedded runs, where such tests are skipped.
   */
  readonly client: postgres.Sql;
  /** Another handle on the same database whose queries go through `logger` (to count them). */
  withLogger(logger: Logger): Database;
  /** Raw SQL as a tagged template, on either driver: rows come back as an array. */
  query<T extends Record<string, unknown> = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  /**
   * Runs `work` in one transaction as the app role (what services run as), with the
   * row-level security tenant `app.company_id` set to `companyId`, or unset for `null`.
   * Raw SQL with `$1` parameters; for the row-level security suite.
   */
  asApp<T>(companyId: string | null, work: (query: RawQuery) => Promise<T>): Promise<T>;
  /** Raw SQL with `$1` parameters as the owner (who sees every company), on either driver. */
  ownerQuery<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]): Promise<R[]>;
  /** Applies the migrations in `folder` (default: the app's) the way this database's mode does. */
  migrate(folder?: string): Promise<void>;
  drop(): Promise<void>;
}

/** One raw statement: its rows, and how many rows it returned or changed. */
export type RawQuery = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: R[]; count: number }>;

const SET_TENANT = "select set_config('app.company_id', $1, true)";

/** Where the app's migrations live; npm scripts run from the repository root. */
export const MIGRATIONS_FOLDER = APP_MIGRATIONS;

/**
 * @param options.migrationsFolder Migrations to apply; defaults to the app's. Tests of a
 *   data migration pass a copy holding only the earlier ones, then apply the rest.
 */
export async function createTestDatabase(options: { migrationsFolder?: string } = {}): Promise<TestDatabase> {
  if (!baseUrl) throw new Error("TEST_DATABASE_URL is not set");
  const folder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  if (embedded) return createEmbeddedTestDatabase(folder);

  const name = `ooohm_test_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  await ensureTestAppRole(admin);
  await admin.unsafe(`create database "${name}"`);

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 10, onnotice: () => {} });
  const db = postgresDatabase(client);
  const grant = () => applyDatabaseRoles(client, { appRole: TEST_APP_ROLE, grantsOnly: true });
  await migrate(drizzle(client), { migrationsFolder: folder });
  await grant();
  url.username = TEST_APP_ROLE;
  url.password = TEST_APP_PASSWORD;
  const appClient = postgres(url.toString(), { max: 10, onnotice: () => {} });
  appDatabases.set(db, postgresDatabase(appClient));

  return {
    db,
    embedded: false,
    client,
    withLogger: (logger) => {
      const owner = postgresDatabase(client, logger);
      appDatabases.set(owner, postgresDatabase(appClient, logger));
      return owner;
    },
    query: (strings, ...values) => executeRows(db, sql(strings, ...values)),
    asApp: (companyId, work) =>
      appClient.begin(async (tx) => {
        if (companyId !== null) await tx.unsafe(SET_TENANT, [companyId]);
        return work(async (text, params = []) => {
          const result = await tx.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
          return { rows: [...result] as never[], count: result.count };
        });
      }) as Promise<never>,
    ownerQuery: async (text, params = []) => [...(await client.unsafe(text, params as postgres.ParameterOrJSON<never>[]))] as never[],
    migrate: async (to = MIGRATIONS_FOLDER) => {
      await migrate(drizzle(client), { migrationsFolder: to });
      await grant();
    },
    async drop() {
      await appClient.end();
      await client.end();
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}

/**
 * The role services run as in Postgres tests, like the app role in production: no
 * superuser, no BYPASSRLS, the app role's grants (deploy/db-roles.sql), so row-level
 * security holds for every service call. Roles belong to the server, so every test file
 * shares this one; the test databases' owner is `TEST_DATABASE_URL`'s user.
 */
export const TEST_APP_ROLE = "ooohm_test_app";
const TEST_APP_PASSWORD = "ooohm_test_app";

async function ensureTestAppRole(server: postgres.Sql): Promise<void> {
  const [found] = await server`select 1 as found from pg_roles where rolname = ${TEST_APP_ROLE}`;
  if (found) return;
  try {
    await server.unsafe(`create role ${TEST_APP_ROLE} login password '${TEST_APP_PASSWORD}' nosuperuser nobypassrls nocreatedb nocreaterole`);
  } catch (err) {
    // Another test file created it first.
    const code = (err as { code?: string }).code;
    if (code !== "42710" && code !== "23505") throw err;
  }
}

/**
 * What each test database's owner handle stands for in a service context: the app role's
 * handle on the same database. Tests seed and assert through the owner (`t.db`), which
 * sees every company; services run as the app role, held to row-level security.
 */
const appDatabases = new WeakMap<Database, Database>();

/** A fresh in-memory PGlite database, migrated the way embedded mode migrates. */
async function createEmbeddedTestDatabase(folder: string): Promise<TestDatabase> {
  const config = { kind: "embedded" as const, dataDir: "memory" };
  const handle = await openEmbedded(config, { purpose: "tests" });
  await migrateDatabase(config, { embedded: handle, migrationsFolder: folder });
  const db = handle.db;
  const client = handle.client as unknown as EmbeddedClientLike;
  const app = embeddedRoleClient(client);
  appDatabases.set(db, embeddedDatabase(drizzlePglite, app));
  return {
    db,
    embedded: true,
    get client(): postgres.Sql {
      throw new Error("This test needs a Postgres server; skip it on embedded runs with `needsServer`.");
    },
    withLogger: (logger) => {
      const owner = embeddedDatabase(drizzlePglite, client, logger);
      appDatabases.set(owner, embeddedDatabase(drizzlePglite, app, logger));
      return owner;
    },
    query: (strings, ...values) => executeRows(db, sql(strings, ...values)),
    asApp: (companyId, work) =>
      app.transaction(async (tx) => {
        if (companyId !== null) await tx.query(SET_TENANT, [companyId]);
        return work(async (text, params = []) => {
          const result = (await tx.query(text, params)) as { rows: never[]; affectedRows?: number };
          return { rows: result.rows, count: result.affectedRows || result.rows.length };
        });
      }),
    ownerQuery: async (text, params = []) => ((await client.query(text, params)) as { rows: never[] }).rows,
    migrate: (to = MIGRATIONS_FOLDER) => migrateDatabase(config, { embedded: handle, migrationsFolder: to }),
    drop: () => handle.close(),
  };
}

/** A `ServiceContext` that records email instead of sending it. */
export interface TestContext extends ServiceContext {
  /** Emails delivered so far (after `settle()`). */
  sent: MailMessage[];
  /** Addresses `issueSignInLink` was asked for, in order. */
  signInLinks: string[];
  /** Number of deferred tasks scheduled so far, run or not. */
  deferred(): number;
  /**
   * Runs the deferred tasks scheduled since the last call, i.e. the post-commit
   * emails. Like `after()` in the app, nothing deferred runs until then.
   */
  settle(): Promise<void>;
}

/** A fixed WEBHOOK_ENCRYPTION_KEY for tests (32 bytes, base64). */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/** Signs the approve links in test emails. */
export const TEST_LINK_KEY = "test-email-link-key";

export function createTestContext(
  db: Database,
  options: {
    now?: Date;
    mailer?: (m: MailMessage) => Promise<void>;
    issueSignInLink?: (email: string) => Promise<string>;
    adapters?: AdapterRegistry;
    webhookTargets?: TargetPolicy;
  } = {},
): TestContext {
  const sent: MailMessage[] = [];
  const signInLinks: string[] = [];
  const queue: (() => Promise<void>)[] = [];
  let scheduled = 0;
  return {
    // Services run as the app role, held to row-level security, when `db` is a test database's owner handle.
    db: appDatabases.get(db) ?? db,
    appUrl: "https://ooohm.test",
    linkKey: TEST_LINK_KEY,
    now: () => options.now ?? new Date("2026-11-01T15:00:00Z"),
    ids: uuidGenerator,
    mailer: options.mailer ?? (async (m) => void sent.push(m)),
    defer: (task) => {
      scheduled++;
      queue.push(task);
    },
    issueSignInLink:
      options.issueSignInLink ??
      (async (email) => {
        signInLinks.push(email);
        return `https://ooohm.test/api/auth/magic-link/verify?token=test-${signInLinks.length}&callbackURL=%2F`;
      }),
    secrets: createSecretBox(TEST_ENCRYPTION_KEY),
    webhookTargets: options.webhookTargets ?? STRICT_TARGET_POLICY,
    adapters: options.adapters ?? createAdapterRegistry(),
    sent,
    signInLinks,
    deferred: () => scheduled,
    settle: async () => {
      while (queue.length > 0) await queue.shift()!();
    },
  };
}

/**
 * {@link createTestContext} on the database's owner, past row-level security: for what
 * production runs as the owner (the TimeOff import, the seed), never for services.
 */
export function createOwnerTestContext(db: Database, options: Parameters<typeof createTestContext>[1] = {}): TestContext {
  return { ...createTestContext(db, options), db };
}

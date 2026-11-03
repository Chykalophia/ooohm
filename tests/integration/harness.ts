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
 */
import { randomUUID } from "node:crypto";
import { type Logger, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { MIGRATIONS_FOLDER as APP_MIGRATIONS, migrateDatabase, openEmbedded } from "@/db/connect";
import { executeRows } from "@/db/rows";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import { STRICT_TARGET_POLICY, type TargetPolicy } from "@/domain/webhook-target";
import { createSecretBox } from "@/lib/integration-crypto";
import type { MailMessage, ServiceContext } from "@/server/context";
import { type AdapterRegistry, createAdapterRegistry } from "@/server/integrations/adapter";

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
  /** Applies the migrations in `folder` (default: the app's) the way this database's mode does. */
  migrate(folder?: string): Promise<void>;
  drop(): Promise<void>;
}

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
  await admin.unsafe(`create database "${name}"`);

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: folder });

  return {
    db,
    embedded: false,
    client,
    withLogger: (logger) => drizzle(client, { schema, casing: "snake_case", logger }),
    query: (strings, ...values) => executeRows(db, sql(strings, ...values)),
    migrate: (to = MIGRATIONS_FOLDER) => migrate(db, { migrationsFolder: to }),
    async drop() {
      await client.end();
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}

/** A fresh in-memory PGlite database, migrated the way embedded mode migrates. */
async function createEmbeddedTestDatabase(folder: string): Promise<TestDatabase> {
  const config = { kind: "embedded" as const, dataDir: "memory" };
  const handle = await openEmbedded(config, { purpose: "tests" });
  await migrateDatabase(config, { embedded: handle, migrationsFolder: folder });
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const db = handle.db;
  return {
    db,
    embedded: true,
    get client(): postgres.Sql {
      throw new Error("This test needs a Postgres server; skip it on embedded runs with `needsServer`.");
    },
    withLogger: (logger) => drizzlePglite(handle.client, { schema, casing: "snake_case", logger }) as unknown as Database,
    query: (strings, ...values) => executeRows(db, sql(strings, ...values)),
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
    db,
    appUrl: "https://ooohm.test",
    linkKey: TEST_LINK_KEY,
    now: () => options.now ?? new Date("2026-11-01T15:00:00Z"),
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

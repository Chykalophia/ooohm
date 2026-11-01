/**
 * Integration test harness: a fresh, fully migrated Postgres database per test file.
 *
 * Set `TEST_DATABASE_URL` to any database on a server where the user may create
 * databases (e.g. `postgres://postgres:pw@127.0.0.1:55502/postgres`). Each file gets
 * its own `ooohm_test_<random>` database, so files run in parallel without sharing
 * state; it is dropped when the file finishes. Without the variable, suites skip with
 * a message instead of failing, so `pnpm test:integration` is safe to run anywhere.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import type { MailMessage, ServiceContext } from "@/server/context";

const baseUrl = process.env.TEST_DATABASE_URL;

/** Pass as `describe(name, { skip }, ...)`: `false` when a database is configured. */
export const skip: string | false = baseUrl
  ? false
  : "TEST_DATABASE_URL is not set; skipping integration tests. See docs/architecture.md#testing.";

export interface TestDatabase {
  db: Database;
  /** The underlying connection pool, e.g. to build a second, instrumented `db` on it. */
  client: postgres.Sql;
  drop(): Promise<void>;
}

/** Where the app's migrations live; npm scripts run from the repository root. */
export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");

/**
 * @param options.migrationsFolder Migrations to apply; defaults to the app's. Tests of a
 *   data migration pass a copy holding only the earlier ones, then apply the rest.
 */
export async function createTestDatabase(options: { migrationsFolder?: string } = {}): Promise<TestDatabase> {
  if (!baseUrl) throw new Error("TEST_DATABASE_URL is not set");
  const name = `ooohm_test_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });

  return {
    db,
    client,
    async drop() {
      await client.end();
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}

/** A `ServiceContext` that records email instead of sending it. */
export interface TestContext extends ServiceContext {
  /** Emails delivered so far (after `settle()`). */
  sent: MailMessage[];
  /** Number of deferred tasks scheduled so far, run or not. */
  deferred(): number;
  /**
   * Runs the deferred tasks scheduled since the last call, i.e. the post-commit
   * emails. Like `after()` in the app, nothing deferred runs until then.
   */
  settle(): Promise<void>;
}

export function createTestContext(
  db: Database,
  options: { now?: Date; mailer?: (m: MailMessage) => Promise<void> } = {},
): TestContext {
  const sent: MailMessage[] = [];
  const queue: (() => Promise<void>)[] = [];
  let scheduled = 0;
  return {
    db,
    appUrl: "https://ooohm.test",
    now: () => options.now ?? new Date("2026-11-01T15:00:00Z"),
    mailer: options.mailer ?? (async (m) => void sent.push(m)),
    defer: (task) => {
      scheduled++;
      queue.push(task);
    },
    sent,
    deferred: () => scheduled,
    settle: async () => {
      while (queue.length > 0) await queue.shift()!();
    },
  };
}

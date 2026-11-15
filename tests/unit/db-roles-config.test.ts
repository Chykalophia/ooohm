import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ADMIN_URL_MISSING, databaseUser, DEFAULT_EMBEDDED_DIR, resolveAdminDatabaseConfig, resolveDatabaseConfig } from "@/db/config";
import { loadWorkerEnv } from "@/lib/worker-env";
import { adminDatabaseConfig, roleSetupFromEnv, roleSetupUrl } from "@/server/admin/db";

const APP = "postgres://ooohm_app:app@db:5432/ooohm";
const OWNER = "postgres://ooohm_owner:owner@db:5432/ooohm";
const NEON_POOLED = "postgresql://ooohm_app:a@ep-cool-1-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const NEON_OWNER_DIRECT = "postgresql://neondb_owner:o@ep-cool-1.us-east-2.aws.neon.tech/neondb?sslmode=require";

describe("database roles: which connection each process uses", () => {
  test("Postgres: migrate, seed and import need DATABASE_ADMIN_URL, and say what to set without it", () => {
    assert.throws(() => resolveAdminDatabaseConfig({ DATABASE_URL: APP }), (err: Error) => {
      assert.equal(err.message, ADMIN_URL_MISSING);
      assert.match(err.message, /^DATABASE_ADMIN_URL is not set\./);
      assert.match(err.message, /docs\/deploy\.md#database-roles/);
      return true;
    });
    assert.throws(() => resolveAdminDatabaseConfig({ OOOHM_DB: "postgres" }), /DATABASE_ADMIN_URL is not set/);
    assert.throws(() => resolveAdminDatabaseConfig({}), /DATABASE_ADMIN_URL is not set/);
  });

  test("DATABASE_URL_UNPOOLED is not a fallback for the owner: an unsplit deployment fails instead of migrating", () => {
    assert.throws(() => resolveAdminDatabaseConfig({ DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_OWNER_DIRECT, VERCEL: "1" }), /DATABASE_ADMIN_URL is not set/);
  });

  test("the owner's config connects and migrates over DATABASE_ADMIN_URL, never DATABASE_URL", () => {
    const c = resolveAdminDatabaseConfig({ DATABASE_URL: APP, DATABASE_ADMIN_URL: OWNER });
    assert.deepEqual(c, { kind: "postgres", url: OWNER, migrationUrl: OWNER, prepare: true, max: 10, idleTimeout: undefined });
    const neon = resolveAdminDatabaseConfig({ DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_OWNER_DIRECT, DATABASE_ADMIN_URL: NEON_OWNER_DIRECT, VERCEL: "1" });
    assert.equal(neon.kind === "postgres" && neon.url, NEON_OWNER_DIRECT);
    assert.equal(neon.kind === "postgres" && neon.migrationUrl, NEON_OWNER_DIRECT);
    assert.equal(neon.kind === "postgres" && neon.prepare, true, "a direct host keeps prepared statements");
  });

  test("the owner's prepared statements follow its own host; DATABASE_POOLER describes DATABASE_URL only", () => {
    const pooled = resolveAdminDatabaseConfig({ DATABASE_URL: APP, DATABASE_ADMIN_URL: "postgres://o:p@ep-x-pooler.eu-central-1.aws.neon.tech/db" });
    assert.equal(pooled.kind === "postgres" && pooled.prepare, false);
    const direct = resolveAdminDatabaseConfig({ DATABASE_URL: APP, DATABASE_POOLER: "transaction", DATABASE_ADMIN_URL: OWNER });
    assert.equal(direct.kind === "postgres" && direct.prepare, true);
  });

  test("a DATABASE_ADMIN_URL that is not a postgres:// URL is refused", () => {
    assert.throws(() => resolveAdminDatabaseConfig({ DATABASE_URL: APP, DATABASE_ADMIN_URL: "mysql://h/db" }), /DATABASE_ADMIN_URL must start with postgres:\/\//);
    assert.throws(() => resolveAdminDatabaseConfig({ DATABASE_URL: APP, DATABASE_ADMIN_URL: "pglite:./data" }), /DATABASE_ADMIN_URL must start with postgres:\/\//);
    assert.throws(() => resolveAdminDatabaseConfig({ OOOHM_DB: "sqlite", DATABASE_ADMIN_URL: OWNER }), /OOOHM_DB/);
  });

  test("embedded PGlite: the owner's config is the app's single handle, with or without DATABASE_ADMIN_URL", () => {
    assert.deepEqual(resolveAdminDatabaseConfig({ OOOHM_DB: "embedded" }), { kind: "embedded", dataDir: DEFAULT_EMBEDDED_DIR });
    assert.deepEqual(resolveAdminDatabaseConfig({ OOOHM_DB: "embedded", DATABASE_ADMIN_URL: OWNER }), resolveDatabaseConfig({ OOOHM_DB: "embedded" }));
    assert.deepEqual(resolveAdminDatabaseConfig({ DATABASE_URL: "pglite:./data/ooohm" }), { kind: "embedded", dataDir: "./data/ooohm" });
  });

  test("the app and the worker connect with DATABASE_URL even when DATABASE_ADMIN_URL is set", () => {
    const app = resolveDatabaseConfig({ DATABASE_URL: APP, DATABASE_ADMIN_URL: OWNER });
    assert.equal(app.kind === "postgres" && app.url, APP);
    const key = Buffer.alloc(32, 3).toString("base64");
    const worker = loadWorkerEnv({ DATABASE_URL: APP, DATABASE_ADMIN_URL: OWNER, WEBHOOK_ENCRYPTION_KEY: key });
    assert.equal(worker.database.kind === "postgres" && worker.database.url, APP);
    assert.ok(!JSON.stringify(worker).includes("owner@"), "the worker's settings never carry the owner's URL");
  });

  test("the owner's settings are trimmed, and the role setup reads its own variables", () => {
    const c = adminDatabaseConfig({ DATABASE_URL: APP, DATABASE_ADMIN_URL: `${OWNER}\n` });
    assert.equal(c.kind === "postgres" && c.url, OWNER);
    assert.deepEqual(roleSetupFromEnv({ OOOHM_DB_OWNER_ROLE: "neondb_owner ", OOOHM_DB_APP_PASSWORD: "pw\n", OOOHM_DB_APP_ROLE: "" }), {
      ownerRole: "neondb_owner",
      appRole: undefined,
      ownerPassword: undefined,
      appPassword: "pw",
    });
    assert.equal(roleSetupUrl({ DATABASE_ADMIN_URL: OWNER }), OWNER);
    assert.equal(roleSetupUrl({ DATABASE_ADMIN_URL: OWNER, DATABASE_SUPERUSER_URL: "postgres://root:r@db/ooohm" }), "postgres://root:r@db/ooohm");
  });

  test("databaseUser reads the role out of a URL", () => {
    assert.equal(databaseUser(APP), "ooohm_app");
    assert.equal(databaseUser("postgres://h/db"), undefined);
    assert.equal(databaseUser("not a url"), undefined);
    assert.equal(databaseUser(undefined), undefined);
  });
});

describe("database roles: the scripts that need the owner refuse without it", () => {
  const ROOT = join(import.meta.dirname, "..", "..");
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  // Only the app's URL, as a Postgres deployment had before the split. Nothing connects:
  // each script stops while resolving its settings.
  const env = { NODE_ENV: "test" as const, PATH: process.env.PATH, DATABASE_URL: "postgres://ooohm:ooohm@127.0.0.1:1/none", VERCEL_ENV: "production", SEED_ADMIN_EMAIL: "admin@example.com" };
  const cases: [string, string[]][] = [
    ["scripts/migrate.mts", ["--if-production"]],
    ["scripts/seed.mts", ["--if-production"]],
    ["scripts/import-timeoff.mts", ["--file", "missing.sqlite", "--company", "c", "--actor", "a@example.com"]],
  ];
  for (const [script, args] of cases) {
    test(`${script} (the Vercel build runs migrate and seed) names DATABASE_ADMIN_URL and the docs`, () => {
      const run = spawnSync(tsx, ["--conditions=react-server", script, ...args], { cwd: ROOT, env, encoding: "utf8" });
      assert.notEqual(run.status, 0, `${script} must fail`);
      assert.match(run.stderr, /DATABASE_ADMIN_URL is not set/);
      assert.match(run.stderr, /docs\/deploy\.md#database-roles/);
    });
  }
});

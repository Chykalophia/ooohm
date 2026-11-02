import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { handleCronTick } from "@/app/api/cron/tick/handler";
import { DEFAULT_EMBEDDED_DIR, resolveDatabaseConfig, usesTransactionPooler } from "@/db/config";
import { acquireEmbeddedLock, lockPathFor } from "@/db/embedded-lock";
import { resolveBackgroundMode } from "@/lib/background-mode";
import { isCronAuthorized } from "@/lib/cron-auth";
import { nonEmptyEnv } from "@/lib/integration-env";
import { loadWorkerEnv } from "@/lib/worker-env";
import { createTickScheduler } from "@/server/services/background-tick";

describe("database configuration", () => {
  test("a Postgres URL: direct, prepared statements on, a normal pool; migrations use the unpooled URL when given", () => {
    const c = resolveDatabaseConfig({ DATABASE_URL: "postgres://u:p@db:5432/ooohm" });
    assert.deepEqual(c, { kind: "postgres", url: "postgres://u:p@db:5432/ooohm", migrationUrl: "postgres://u:p@db:5432/ooohm", prepare: true, max: 10, idleTimeout: undefined });
    const neon = resolveDatabaseConfig({
      DATABASE_URL: "postgresql://u:p@ep-cool-1-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
      DATABASE_URL_UNPOOLED: "postgresql://u:p@ep-cool-1.us-east-2.aws.neon.tech/neondb?sslmode=require",
      VERCEL: "1",
    });
    assert.equal(neon.kind, "postgres");
    if (neon.kind !== "postgres") return;
    assert.equal(neon.prepare, false, "Neon's -pooler host is a transaction pooler");
    assert.equal(neon.migrationUrl, "postgresql://u:p@ep-cool-1.us-east-2.aws.neon.tech/neondb?sslmode=require");
    assert.match(neon.url, /sslmode=require/, "the URL (and its sslmode) reaches the driver unchanged");
    assert.deepEqual([neon.max, neon.idleTimeout], [3, 20], "serverless: a small pool that lets go when idle");
  });

  test("transaction poolers are detected by Neon's host, Supabase's port 6543, or DATABASE_POOLER", () => {
    assert.equal(usesTransactionPooler("postgres://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"), true);
    assert.equal(usesTransactionPooler("postgres://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"), false, "session mode");
    assert.equal(usesTransactionPooler("postgres://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/db"), true);
    assert.equal(usesTransactionPooler("postgres://u:p@ep-x.eu-central-1.aws.neon.tech/db"), false);
    assert.equal(usesTransactionPooler("postgres://u:p@pgbouncer:6432/db", "transaction"), true);
    assert.equal(usesTransactionPooler("postgres://u:p@host:6543/db", "session"), false, "an explicit setting wins");
  });

  test("DATABASE_SERVERLESS and DATABASE_POOL_MAX size the pool; bad values are refused", () => {
    const c = resolveDatabaseConfig({ DATABASE_URL: "postgres://u:p@h/db", DATABASE_SERVERLESS: "true" });
    assert.equal(c.kind === "postgres" && c.max, 3);
    const d = resolveDatabaseConfig({ DATABASE_URL: "postgres://u:p@h/db", DATABASE_POOL_MAX: "25" });
    assert.equal(d.kind === "postgres" && d.max, 25);
    assert.throws(() => resolveDatabaseConfig({ DATABASE_URL: "postgres://u:p@h/db", DATABASE_POOL_MAX: "0" }), /DATABASE_POOL_MAX/);
    assert.throws(() => resolveDatabaseConfig({ DATABASE_URL: "postgres://u:p@h/db", DATABASE_POOLER: "yes" }), /DATABASE_POOLER/);
  });

  test("embedded mode: OOOHM_DB=embedded (winning over a postgres URL left in .env) or a pglite: URL", () => {
    assert.deepEqual(resolveDatabaseConfig({ OOOHM_DB: "embedded" }), { kind: "embedded", dataDir: DEFAULT_EMBEDDED_DIR });
    assert.deepEqual(resolveDatabaseConfig({ OOOHM_DB: "embedded", DATABASE_URL: "postgres://u:p@h/db" }), { kind: "embedded", dataDir: DEFAULT_EMBEDDED_DIR });
    assert.deepEqual(resolveDatabaseConfig({ DATABASE_URL: "pglite:./data/ooohm" }), { kind: "embedded", dataDir: "./data/ooohm" });
    assert.deepEqual(resolveDatabaseConfig({ OOOHM_DB: "embedded", OOOHM_DATA_DIR: "/var/lib/ooohm" }), { kind: "embedded", dataDir: "/var/lib/ooohm" });
  });

  test("nothing usable is a clear error", () => {
    assert.throws(() => resolveDatabaseConfig({}), /DATABASE_URL is not set/);
    assert.throws(() => resolveDatabaseConfig({ DATABASE_URL: "mysql://h/db" }), /postgres:\/\//);
    assert.throws(() => resolveDatabaseConfig({ OOOHM_DB: "sqlite" }), /OOOHM_DB/);
  });

  test("values are trimmed, so a secret stored with a trailing newline still works", () => {
    assert.deepEqual(nonEmptyEnv({ A: "value\n", B: "  ", C: undefined, D: "" }), { A: "value" });
    const key = Buffer.alloc(32, 3).toString("base64");
    const env = loadWorkerEnv({ DATABASE_URL: "postgres://u:p@db:5432/x\n", WEBHOOK_ENCRYPTION_KEY: `${key}\n` });
    assert.equal(env.database.kind === "postgres" && env.database.url, "postgres://u:p@db:5432/x");
    assert.equal(env.WEBHOOK_ENCRYPTION_KEY, key);
  });
});

describe("background mode", () => {
  test("inline on Vercel and in embedded mode, worker elsewhere; an explicit setting wins", () => {
    assert.equal(resolveBackgroundMode(undefined, { vercel: true, embedded: false }), "inline");
    assert.equal(resolveBackgroundMode(undefined, { vercel: false, embedded: true }), "inline");
    assert.equal(resolveBackgroundMode(undefined, { vercel: false, embedded: false }), "worker");
    assert.equal(resolveBackgroundMode("cron", { vercel: true, embedded: false }), "cron");
    assert.equal(resolveBackgroundMode("worker", { vercel: true, embedded: false }), "worker");
  });

  test("worker mode is refused with the embedded database, which one process owns", () => {
    assert.throws(() => resolveBackgroundMode("worker", { vercel: false, embedded: true }), /embedded/);
  });
});

describe("embedded directory lock", () => {
  test("one live process holds it; another gets a message naming the holder; a dead holder's lock is taken over", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ooohm-lock-"));
    const data = path.join(dir, "pglite");
    try {
      const lock = acquireEmbeddedLock(data, "the app");
      assert.equal(lock.path, lockPathFor(data));
      assert.equal(JSON.parse(readFileSync(lock.path, "utf8")).pid, process.pid);
      // The same process may open it again (a hot reload).
      acquireEmbeddedLock(data, "the app");

      // Another live process: pid 1 always exists.
      writeFileSync(lock.path, JSON.stringify({ pid: 1, purpose: "pnpm worker", since: "2026-11-01T00:00:00Z" }));
      assert.throws(() => acquireEmbeddedLock(data, "the app"), /in use by pnpm worker \(process 1/);

      // A holder that has exited: taken over.
      writeFileSync(lock.path, JSON.stringify({ pid: 2 ** 22 + 12345, purpose: "the app", since: "x" }));
      const again = acquireEmbeddedLock(data, "pnpm db:migrate");
      assert.equal(JSON.parse(readFileSync(again.path, "utf8")).purpose, "pnpm db:migrate");
      again.release();
      assert.throws(() => readFileSync(again.path), /ENOENT/, "released");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cron route", () => {
  const SECRET = "s".repeat(40);
  const call = (authorization?: string) =>
    new Request("https://ooohm.test/api/cron/tick", { headers: authorization ? { authorization } : {} });

  test("the bearer secret must match exactly; anything else is refused", () => {
    assert.equal(isCronAuthorized(`Bearer ${SECRET}`, SECRET), true);
    for (const header of [null, "", SECRET, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(1)}`, `bearer ${SECRET}`, `Basic ${SECRET}`]) {
      assert.equal(isCronAuthorized(header, SECRET), false, String(header));
    }
    assert.equal(isCronAuthorized("Bearer ", ""), false);
    assert.equal(isCronAuthorized(`Bearer ${SECRET}`, undefined), false, "no secret configured: always refused");
  });

  test("401 with an empty body and no tick without the secret; 200 with counts and no-store with it", async () => {
    let ticks = 0;
    const deps = { secret: SECRET, tick: async () => (ticks++, { events: 2, webhooksDelivered: 1, stoppedEarly: false }) };
    const refused = await handleCronTick(call(), deps);
    assert.equal(refused.status, 401);
    assert.equal(await refused.text(), "");
    assert.equal(refused.headers.get("cache-control"), "no-store");
    assert.equal((await handleCronTick(call("Bearer wrong"), deps)).status, 401);
    assert.equal(ticks, 0);

    const ok = await handleCronTick(call(`Bearer ${SECRET}`), deps);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.deepEqual(await ok.json(), { status: "ok", events: 2, webhooksDelivered: 1, stoppedEarly: false });
    assert.equal(ticks, 1);
  });

  test("with no CRON_SECRET set, every call is refused and the operator is told", async () => {
    let told = 0;
    const res = await handleCronTick(call("Bearer anything"), { secret: undefined, tick: async () => ({}), onUnconfigured: () => void told++ });
    assert.equal(res.status, 401);
    assert.equal(told, 1);
  });

  test("a failed tick is a bare 500", async () => {
    const res = await handleCronTick(call(`Bearer ${SECRET}`), {
      secret: SECRET,
      tick: async () => {
        throw new Error("connection refused to postgres://u:secret@db");
      },
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { status: "error" });
  });
});

describe("tick scheduler", () => {
  test("requests during a tick fold into one more pass; each request resolves only once covered", async () => {
    let runs = 0;
    let release!: () => void;
    const scheduler = createTickScheduler(async () => {
      runs++;
      if (runs === 1) await new Promise<void>((r) => (release = r));
    });
    const first = scheduler.request();
    const second = scheduler.request();
    const third = scheduler.request();
    assert.equal(runs, 1, "no second tick side by side");
    let settled = false;
    void second.then(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, "waits for the pass that covers it");
    release();
    await Promise.all([first, second, third]);
    assert.equal(runs, 2, "three requests, two passes");
    await scheduler.request();
    assert.equal(runs, 3, "an idle scheduler starts a new pass");
  });
});

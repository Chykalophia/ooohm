import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { and, count, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Actor } from "@/domain/actor";
import type { ApiClient } from "@/domain/integrations";
import { createRateLimiter } from "@/lib/rate-limit";
import { createApiKey, revokeApiKey } from "@/server/services/api-keys";
import {
  listBalancesForApi,
  listEventsForApi,
  listHolidaysForApi,
  listLeaveRequestsForApi,
  listLeaveTypesForApi,
  listUsersForApi,
} from "@/server/services/api-v1";
import { getBalanceSummary } from "@/server/services/balances";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { type ApiLimits, handleApiRequest, parseQuery, REQUESTS_PER_KEY_PER_MINUTE, UNAUTHORIZED_PER_CLIENT_PER_MINUTE } from "@/app/api/v1/_lib/handler";
import { openApiDocument } from "@/app/api/v1/_lib/openapi";
import { balancesQuery, eventsQuery, holidaysQuery, leaveRequestsQuery, usersQuery } from "@/app/api/v1/_lib/query";
import type { ServiceContext } from "@/server/context";
import { companyEvents, eventsFor, setAllowance, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, needsServer, skip, type TestDatabase } from "./harness";

/** What each route file does: the same one-line parse-and-call, without Next. */
const ROUTES: Record<string, (ctx: ServiceContext, client: Parameters<typeof listUsersForApi>[1], q: URLSearchParams) => Promise<unknown>> = {
  "/api/v1/users": (ctx, c, q) => listUsersForApi(ctx, c, parseQuery(usersQuery, q)),
  "/api/v1/leave-types": (ctx, c) => listLeaveTypesForApi(ctx, c),
  "/api/v1/leave-requests": (ctx, c, q) => listLeaveRequestsForApi(ctx, c, parseQuery(leaveRequestsQuery, q)),
  "/api/v1/balances": (ctx, c, q) => listBalancesForApi(ctx, c, parseQuery(balancesQuery, q)),
  "/api/v1/holidays": (ctx, c, q) => listHolidaysForApi(ctx, c, parseQuery(holidaysQuery, q)),
  "/api/v1/events": (ctx, c, q) => listEventsForApi(ctx, c, parseQuery(eventsQuery, q)),
};

const freshLimits = (): ApiLimits => ({
  perKey: createRateLimiter({ limit: REQUESTS_PER_KEY_PER_MINUTE, windowMs: 60_000 }),
  unauthorized: createRateLimiter({ limit: UNAUTHORIZED_PER_CLIENT_PER_MINUTE, windowMs: 60_000 }),
});

describe("REST API v1", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  function api(ctx: ServiceContext, limits = freshLimits()) {
    return async (route: string, key: string | null, query: Record<string, string> = {}, client = "198.51.100.1") => {
      const headers = new Headers(key === null ? {} : { Authorization: key.startsWith("Bearer") || key.startsWith("Basic") ? key : `Bearer ${key}` });
      const res = await handleApiRequest({ ctx, headers, client, limits, route }, (c) => ROUTES[route](ctx, c, new URLSearchParams(query)));
      return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> & { data?: Record<string, unknown>[]; nextCursor?: string | null } };
    };
  }

  async function companyWithKey() {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" }, ben: { managerKey: "boss" }, cy: { managerKey: "boss" } });
    const ctx = createTestContext(t.db, { now: new Date("2026-11-02T15:00:00Z") });
    const { key, apiKey } = await createApiKey(ctx, co.people.boss, { name: "test" });
    return { co, ctx, key, keyId: apiKey.id };
  }

  test("401 without a key, with a malformed, unknown or revoked one: the same answer, no detail, never cached", async () => {
    const { co, ctx, key, keyId } = await companyWithKey();
    const call = api(ctx);
    const answers = [
      await call("/api/v1/users", null),
      await call("/api/v1/users", "Basic dXNlcjpwdw=="),
      await call("/api/v1/users", "ooohm_short"),
      await call("/api/v1/users", "ooohm_" + "B".repeat(43)),
    ];
    await revokeApiKey(ctx, co.people.boss, keyId);
    answers.push(await call("/api/v1/users", key));
    for (const a of answers) {
      assert.equal(a.status, 401);
      assert.equal(a.headers.get("www-authenticate"), 'Bearer realm="OOOhm API"');
      assert.equal(a.headers.get("cache-control"), "no-store");
      assert.equal((a.body.error as { code: string }).code, "unauthorized");
    }
    assert.equal(new Set(answers.map((a) => JSON.stringify(a.body))).size, 1, "nothing distinguishes the cases");
  });

  test("429 with Retry-After per key; another key is unaffected; the window resets", async () => {
    const { co, ctx, key } = await companyWithKey();
    const { key: second } = await createApiKey(ctx, co.people.boss, { name: "second" });
    const clock = { now: 0 };
    const limits = {
      perKey: createRateLimiter({ limit: REQUESTS_PER_KEY_PER_MINUTE, windowMs: 60_000, now: () => clock.now }),
      unauthorized: createRateLimiter({ limit: UNAUTHORIZED_PER_CLIENT_PER_MINUTE, windowMs: 60_000, now: () => clock.now }),
    };
    const call = api(ctx, limits);
    for (let i = 0; i < REQUESTS_PER_KEY_PER_MINUTE; i++) assert.equal((await call("/api/v1/leave-types", key)).status, 200);
    const limited = await call("/api/v1/leave-types", key);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal((limited.body.error as { code: string }).code, "rate_limited");
    assert.equal((await call("/api/v1/leave-types", second)).status, 200);
    clock.now = 60_000;
    assert.equal((await call("/api/v1/leave-types", key)).status, 200);
  });

  test("a client sending bad keys gets 429 after its budget, while a valid key from the same address still works", async () => {
    const { ctx, key } = await companyWithKey();
    const call = api(ctx);
    for (let i = 0; i < UNAUTHORIZED_PER_CLIENT_PER_MINUTE; i++) assert.equal((await call("/api/v1/users", "ooohm_" + "C".repeat(43), {}, "203.0.113.9")).status, 401);
    assert.equal((await call("/api/v1/users", "ooohm_" + "C".repeat(43), {}, "203.0.113.9")).status, 429);
    assert.equal((await call("/api/v1/users", key, {}, "203.0.113.9")).status, 200);
  });

  test("a key without the read scope gets 403", async () => {
    const { ctx, key, keyId } = await companyWithKey();
    await t.db.update(schema.apiKeys).set({ scopes: ["write"] }).where(eq(schema.apiKeys.id, keyId));
    const res = await api(ctx)("/api/v1/users", key);
    assert.equal(res.status, 403);
    assert.equal((res.body.error as { code: string }).code, "forbidden");
  });

  test("users: keyset pages cover everyone exactly once; a bad cursor or limit is a 400 naming it", async () => {
    const { ctx, key } = await companyWithKey();
    const call = api(ctx);
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const res = await call("/api/v1/users", key, cursor ? { limit: "2", cursor } : { limit: "2" });
      assert.equal(res.status, 200);
      seen.push(...res.body.data!.map((u) => u.id as string));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 2);
    assert.equal(seen.length, 4);
    assert.deepEqual([...seen].sort(), seen, "ordered by id");

    const first = (await call("/api/v1/users", key)).body.data![0];
    assert.deepEqual(Object.keys(first).sort(), ["createdAt", "department", "email", "id", "isActive", "managerId", "name", "role"]);

    const bad = await call("/api/v1/users", key, { limit: "500" });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.error, { code: "invalid_request", message: "Invalid query parameter: limit." });
    assert.equal((await call("/api/v1/users", key, { cursor: "garbage" })).status, 400);
  });

  test("company scoping: nothing of another company is visible, by listing or by id", async () => {
    const mine = await companyWithKey();
    const theirs = await companyWithKey();
    const req = await submitLeaveRequest(theirs.ctx, theirs.co.people.ana, { leaveTypeId: theirs.co.pto, startDate: "2026-11-09", endDate: "2026-11-09", dayPortion: "full" });
    const call = api(mine.ctx);
    const users = (await call("/api/v1/users", mine.key)).body.data!.map((u) => u.id);
    assert.ok(users.every((id) => Object.values(mine.co.people).some((p) => p.id === id)));
    assert.equal(users.length, 4);
    assert.deepEqual((await call("/api/v1/leave-requests", mine.key)).body.data, []);
    assert.deepEqual((await call("/api/v1/leave-requests", mine.key, { userId: theirs.co.people.ana.id })).body.data, []);
    assert.deepEqual((await call("/api/v1/balances", mine.key, { userId: theirs.co.people.ana.id })).body.data, []);
    const types = (await call("/api/v1/leave-types", mine.key)).body.data!.map((x) => x.id);
    assert.deepEqual([...types].sort(), [mine.co.pto, mine.co.archived].sort());
    const [theirEvent] = await eventsFor(t.db, theirs.co.companyId, req.id);
    const replay = await call("/api/v1/events", mine.key, { after: theirEvent.id });
    assert.equal(replay.status, 400, "another company's event is not a valid cursor");
    const all = (await call("/api/v1/events", mine.key, { limit: "200" })).body.data!;
    assert.ok(all.every((e) => e.companyId === mine.co.companyId));
  });

  test("leave requests: date-overlap and status filters, stable pages across equal start dates, and never a note", async () => {
    const { co, ctx, key } = await companyWithKey();
    const draft = (startDate: string, endDate = startDate) => ({ leaveTypeId: co.pto, startDate, endDate, dayPortion: "full" as const, note: "Hospital visit" });
    for (const who of [co.people.ana, co.people.ben, co.people.cy] as Actor[]) await submitLeaveRequest(ctx, who, draft("2026-11-16"));
    await submitLeaveRequest(ctx, co.people.ana, draft("2026-11-30", "2026-12-02"));
    const early = await submitLeaveRequest(ctx, co.people.ben, draft("2026-11-02"));
    await t.db.update(schema.leaveRequests).set({ status: "rejected" }).where(eq(schema.leaveRequests.id, early.id));

    const call = api(ctx);
    const pageIds: string[] = [];
    let cursor: string | null | undefined;
    do {
      const res = await call("/api/v1/leave-requests", key, { from: "2026-11-10", limit: "2", ...(cursor ? { cursor } : {}) });
      pageIds.push(...res.body.data!.map((r) => r.id as string));
      for (const r of res.body.data!) {
        assert.ok(!("note" in r) && !("decisionNote" in r));
        assert.ok(!JSON.stringify(r).includes("Hospital"));
      }
      cursor = res.body.nextCursor;
    } while (cursor);
    assert.equal(pageIds.length, 4, "three on the 16th and the one into December; the 2nd ends before `from`");
    assert.equal(new Set(pageIds).size, 4, "no repeats across pages on equal start dates");

    const december = await call("/api/v1/leave-requests", key, { from: "2026-12-01", to: "2026-12-31" });
    assert.equal(december.body.data!.length, 1, "overlaps count, not just starts");
    const rejected = await call("/api/v1/leave-requests", key, { status: "rejected" });
    assert.deepEqual(rejected.body.data!.map((r) => r.id), [early.id]);
    const ana = await call("/api/v1/leave-requests", key, { userId: co.people.ana.id });
    assert.equal(ana.body.data!.length, 2);
    assert.equal((await call("/api/v1/leave-requests", key, { from: "2026-12-01", to: "2026-11-01" })).status, 400);
    assert.equal((await call("/api/v1/leave-requests", key, { from: "2026-13-01" })).status, 400);
    assert.equal((await call("/api/v1/leave-requests", key, { status: "lost" })).status, 400);
  });

  test("balances match what the dashboard shows each person; holidays come by year", async () => {
    const { co, ctx, key } = await companyWithKey();
    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: co.pto, year: 2026, days: 15, adjustmentDays: 1 });
    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-09", endDate: "2026-11-10", dayPortion: "full" });
    const call = api(ctx);
    const res = await call("/api/v1/balances", key, { year: "2026", userId: co.people.ana.id });
    assert.equal(res.body.year, 2026);
    const dashboard = await getBalanceSummary(ctx, co.people.ana, 2026);
    const [apiPto] = res.body.data!.filter((b) => b.leaveTypeId === co.pto);
    const [dashPto] = dashboard.items.filter((i) => i.leaveTypeId === co.pto);
    assert.deepEqual({ ...apiPto, userId: undefined, leaveTypeId: undefined, year: undefined }, { userId: undefined, leaveTypeId: undefined, year: undefined, ...dashPto.balance });
    assert.equal(apiPto.pending, 2);
    assert.equal(apiPto.remaining, 14);

    const everyone = await call("/api/v1/balances", key, { year: "2026" });
    assert.equal(new Set(everyone.body.data!.map((b) => b.userId)).size, 4, "every active person");
    const documented = [...openApiDocument.components.schemas.Balance.required].sort();
    assert.ok(everyone.body.data!.some((b) => b.tracked) && everyone.body.data!.some((b) => !b.tracked), "both shapes are checked");
    for (const b of everyone.body.data!) assert.deepEqual(Object.keys(b).sort(), documented, "exactly the documented fields, tracked or not");

    const holidays = await call("/api/v1/holidays", key, { year: "2026" });
    assert.deepEqual(holidays.body.data!.map((h) => [h.date, h.name]), [["2026-11-26", "Thanksgiving"]]);
    assert.deepEqual((await call("/api/v1/holidays", key, { year: "2025" })).body.data, []);
    assert.equal((await call("/api/v1/holidays", key)).body.year, 2026, "defaults to this year in the company's zone");
    assert.equal((await call("/api/v1/holidays", key, { year: "1999" })).status, 400);
  });

  const SETTLE_TIMEOUT_MS = 30_000;

  /**
   * Waits until the API can see every event the company has. Events show once every
   * transaction older than them has ended, cluster-wide (`listCompanyEvents`), and other
   * test files share the server, so one of their transactions can hold ours back for a
   * while. Polls that condition itself, the same comparison the API makes, and fails
   * after {@link SETTLE_TIMEOUT_MS} rather than letting a test read a partial page.
   */
  async function eventsSettled(companyId: string): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    for (;;) {
      const [{ hidden }] = await t.db
        .select({ hidden: count() })
        .from(schema.eventsOutbox)
        .where(
          and(
            eq(schema.eventsOutbox.companyId, companyId),
            sql`${schema.eventsOutbox.txId} >= pg_snapshot_xmin(pg_current_snapshot())::text::bigint`,
          ),
        );
      if (hidden === 0) return;
      if (Date.now() > deadline) assert.fail(`${hidden} events still hidden behind an open transaction after ${SETTLE_TIMEOUT_MS} ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  type Events = { data: { id: string; type: string; version: number; data: Record<string, unknown> }[]; hasMore: boolean };

  test("events: the outbox replayed in order after a cursor, as envelopes; an unknown cursor is 400", async () => {
    const { co, ctx, key } = await companyWithKey();
    const call = api(ctx);
    for (const d of ["2026-11-09", "2026-11-10", "2026-11-11"]) {
      await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: d, endDate: d, dayPortion: "full" });
    }
    await eventsSettled(co.companyId);
    const all = (await call("/api/v1/events", key, { limit: "200" })).body as unknown as Events;
    assert.equal(all.hasMore, false);
    assert.deepEqual(all.data.map((e) => e.type), ["api_key.created", "leave.requested", "leave.requested", "leave.requested"]);
    assert.ok(all.data.every((e) => e.version === 1));

    const first = (await call("/api/v1/events", key, { limit: "2" })).body as unknown as { data: { id: string }[]; hasMore: boolean };
    assert.equal(first.hasMore, true);
    const rest = (await call("/api/v1/events", key, { after: first.data[1].id })).body as unknown as { data: { id: string }[] };
    assert.deepEqual([...first.data, ...rest.data].map((e) => e.id), all.data.map((e) => e.id));
    assert.equal((await call("/api/v1/events", key, { after: "00000000-0000-4000-8000-000000000000" })).status, 400);
  });

  test("events written by a transaction still open never appear behind a reader's cursor", { skip: needsServer }, async () => {
    const { co, ctx, key } = await companyWithKey();
    const call = api(ctx);
    const read = async (query: Record<string, string>) => (await call("/api/v1/events", key, query)).body as unknown as Events;
    await eventsSettled(co.companyId);
    const before = await read({ limit: "200" });
    assert.deepEqual(before.data.map((e) => e.type), ["api_key.created"]);
    const cursor = before.data[0].id;

    const writer = await t.client.reserve();
    let request: { id: string };
    try {
      // A slow transaction writes first (earlier created_at), and is still open when a
      // later one commits.
      await writer`begin`;
      await writer`insert into events_outbox (company_id, type, payload) values (${co.companyId}, 'leave.requested', '{"slow": true}')`;
      request = await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-09", endDate: "2026-11-09", dayPortion: "full" });
      const during = await read({ after: cursor });
      assert.deepEqual(during.data, [], "neither the open row nor the committed one after it shows while the older transaction runs");
      await writer`commit`;
    } finally {
      writer.release();
    }
    await eventsSettled(co.companyId);
    const after = await read({ after: cursor });
    assert.equal(after.data.length, 2);
    assert.equal(after.data[0].data.slow, true, "the slow row is not lost behind the cursor: it comes first");
    assert.equal(after.data[1].data.requestId, request.id);
  });

  test("each page costs a fixed number of queries, whatever it holds", async () => {
    const { co, ctx, key } = await companyWithKey();
    for (const d of ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]) {
      await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: d, endDate: d, dayPortion: "full" });
    }
    let queries = 0;
    const counting = t.withLogger({ logQuery: () => void queries++ });
    const cctx = createTestContext(counting, { now: ctx.now() });
    const call = api(cctx);
    await call("/api/v1/users", key); // stamps last_used_at; later calls in the same minute do not
    const cost = async (route: string, query: Record<string, string> = {}) => {
      queries = 0;
      const res = await call(route, key, query);
      assert.equal(res.status, 200, route);
      return queries;
    };
    // One for the key, then the page.
    assert.equal(await cost("/api/v1/users", { limit: "1" }), 2);
    assert.equal(await cost("/api/v1/users", { limit: "200" }), 2);
    assert.equal(await cost("/api/v1/leave-types"), 2);
    assert.equal(await cost("/api/v1/leave-requests", { limit: "1" }), 2);
    assert.equal(await cost("/api/v1/leave-requests", { limit: "200" }), 2);
    assert.equal(await cost("/api/v1/balances"), 6);
    assert.equal(await cost("/api/v1/balances", { userId: co.people.ana.id }), 6);
    assert.equal(await cost("/api/v1/holidays"), 3);
    assert.equal(await cost("/api/v1/events", { limit: "1" }), 2);
    const [{ id: after }] = await companyEvents(t.db, co.companyId, "leave.requested");
    assert.equal(await cost("/api/v1/events", { after, limit: "200" }), 3);
  });

  test("the OpenAPI document describes every route and method, and nothing that does not exist", () => {
    const root = path.resolve(process.cwd(), "src/app/api/v1");
    const files: { route: string; methods: string[] }[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.ts") {
          const source = readFileSync(full, "utf8");
          const methods = [...source.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1].toLowerCase());
          files.push({ route: "/api/v1/" + path.relative(root, dir).split(path.sep).join("/"), methods });
        }
      }
    };
    walk(root);
    const documented = Object.entries(openApiDocument.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`));
    const implemented = files.flatMap((f) => f.methods.map((m) => `${m} ${f.route}`));
    assert.deepEqual([...documented].sort(), [...implemented].sort());
    assert.equal(openApiDocument.openapi, "3.1.0");
    assert.deepEqual(Object.keys(ROUTES).sort(), files.map((f) => f.route).filter((r) => !r.endsWith("openapi.json")).sort(), "this test calls every route");
  });

  test("the OpenAPI document declares every status and error code the handler actually answers with", async () => {
    const { co, ctx, key } = await companyWithKey();
    const { key: writeOnly, apiKey } = await createApiKey(ctx, co.people.boss, { name: "write only" });
    await t.db.update(schema.apiKeys).set({ scopes: ["write"] }).where(eq(schema.apiKeys.id, apiKey.id));
    const produced: { status: number; code: string }[] = [];
    const call = async (credential: string | null, work: (client: ApiClient) => Promise<unknown>, limits = freshLimits()) => {
      const headers = new Headers(credential ? { Authorization: `Bearer ${credential}` } : {});
      const res = await handleApiRequest({ ctx, headers, client: "198.51.100.7", limits, route: "/api/v1/users" }, work);
      const body = (await res.json()) as { error?: { code: string } };
      if (body.error) produced.push({ status: res.status, code: body.error.code });
    };
    await call(null, async () => []);
    await call(key, async () => parseQuery(usersQuery, new URLSearchParams({ limit: "0" })));
    await call(writeOnly, (client) => ROUTES["/api/v1/users"](ctx, client, new URLSearchParams()));
    await call(key, () => Promise.reject(new Error("boom")));
    const spent = freshLimits();
    for (let i = 0; i < UNAUTHORIZED_PER_CLIENT_PER_MINUTE; i++) spent.unauthorized.take("198.51.100.7");
    await call(null, async () => [], spent);

    const statuses = new Set(produced.map((p) => String(p.status)));
    assert.deepEqual([...statuses].sort(), ["400", "401", "403", "429", "500"], "every error status was exercised");
    const enumCodes = (openApiDocument.components.schemas.Error.properties.error.properties.code.enum as readonly string[]).slice().sort();
    assert.deepEqual([...new Set(produced.map((p) => p.code))].sort(), enumCodes, "the Error enum is exactly the codes produced");
    for (const [route, ops] of Object.entries(openApiDocument.paths)) {
      if (route.endsWith("openapi.json")) continue;
      for (const op of Object.values(ops)) {
        const documented = Object.keys((op as { responses: object }).responses);
        for (const status of ["401", "403", "429", "500"]) assert.ok(documented.includes(status), `${route} documents ${status}`);
      }
    }
  });
});

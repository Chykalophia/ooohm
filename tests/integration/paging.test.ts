import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { and, asc, eq, like, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { encodePageKey, type PageCursor, type Paged } from "@/domain/paging";
import { listPeople, PEOPLE_PAGE_SIZE } from "@/server/services/admin-people";
import {
  cancelLeaveRequest,
  DASHBOARD_REQUESTS,
  getDashboard,
  getMyRequest,
  listMyRequests,
  REQUESTS_PAGE_SIZE,
} from "@/server/services/leave-requests";
import { createWebhookEndpoint, DELIVERIES_PAGE_SIZE, getWebhookEndpoint } from "@/server/services/webhooks";
import { rejectsWith } from "./assertions";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

/**
 * Walks a list forwards to its end, then backwards to its start, and checks both walks
 * see the same pages: every id once, in `expected` order, each page full but the last.
 */
async function walk(read: (page?: PageCursor) => Promise<Paged<{ id: string }>>, expected: string[], size: number) {
  const forward: string[][] = [];
  let page: Paged<{ id: string }> | undefined;
  let cursor: PageCursor | undefined;
  do {
    page = await read(cursor);
    assert.equal(page.previous === null, forward.length === 0, "only page 1 has no previous");
    forward.push(page.items.map((r) => r.id));
    cursor = page.next ?? undefined;
  } while (cursor);
  assert.deepEqual(forward.flat(), expected, "every row once, in order");
  assert.ok(
    forward.slice(0, -1).every((p) => p.length === size),
    "full pages but the last",
  );

  const backward: string[][] = [];
  cursor = page.previous ?? undefined;
  while (cursor) {
    const p = await read(cursor);
    backward.unshift(p.items.map((r) => r.id));
    cursor = p.previous ?? undefined;
  }
  assert.deepEqual(backward, forward.slice(0, -1), "back through the same pages");
}

/** Plain code-unit order, as Postgres compares uuids (no locale rules). */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe("long lists page by their keys", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("people: by name whatever its case, then email, within the filter", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    // 3 names in several cases, so lower(name) ties often and the email decides.
    const names = ["ana", "Ana", "ANA", "Ben", "ben", "Zoë", "zoë", "Émile"];
    await t.db.insert(schema.user).values(
      Array.from({ length: 2 * PEOPLE_PAGE_SIZE + 7 }, (_, i) => ({
        id: randomUUID(),
        companyId: co.companyId,
        name: names[i % names.length],
        email: `p${String(i).padStart(3, "0")}-${randomUUID().slice(0, 4)}@paging.test`,
      })),
    );
    const ids = (
      await t.db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(and(eq(schema.user.companyId, co.companyId), like(schema.user.email, "%@paging.test")))
        .orderBy(asc(sql`lower(${schema.user.name})`), asc(schema.user.email))
    ).map((r) => r.id);
    assert.equal(ids.length, 2 * PEOPLE_PAGE_SIZE + 7);
    await walk(
      async (page) => {
        const r = await listPeople(ctx, co.people.boss, { status: "all", query: "@paging.test" }, page);
        return { items: r.people, previous: r.previous, next: r.next };
      },
      ids,
      PEOPLE_PAGE_SIZE,
    );
  });

  test("a forged people link or search with NUL (which Postgres refuses in text) reads as page 1, not an error", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
    const ctx = createTestContext(t.db);
    const first = (await listPeople(ctx, co.people.boss, { status: "all" })).people.map((p) => p.id);
    for (const direction of ["after", "before"] as const) {
      const page = await listPeople(
        ctx,
        co.people.boss,
        { status: "all" },
        { direction, token: encodePageKey(["ana\u0000", "x@example.com"]) },
      );
      assert.deepEqual(
        page.people.map((p) => p.id),
        first,
        direction,
      );
    }
  });

  test("your requests: latest dates first; same day, then latest sent, then id", async () => {
    const co = await seedCompany(t.db, { ana: {} });
    const ctx = createTestContext(t.db);
    // One insert, so rows share created_at: the id breaks those ties.
    const rows = await t.db
      .insert(schema.leaveRequests)
      .values(
        Array.from({ length: 2 * REQUESTS_PAGE_SIZE + 3 }, (_, i) => ({
          companyId: co.companyId,
          userId: co.people.ana.id,
          leaveTypeId: co.pto,
          startDate: `2026-${String(1 + (i % 4) * 3).padStart(2, "0")}-15`,
          endDate: `2026-${String(1 + (i % 4) * 3).padStart(2, "0")}-15`,
          dayPortion: "full" as const,
          days: 1,
          status: "approved" as const,
        })),
      )
      .returning();
    const expected = [...rows]
      .sort((a, b) => b.startDate.localeCompare(a.startDate) || b.createdAt.getTime() - a.createdAt.getTime() || byText(b.id, a.id))
      .map((r) => r.id);
    await walk(
      async (page) => {
        const r = await listMyRequests(ctx, co.people.ana, page);
        return { items: r.items, previous: r.previous, next: r.next };
      },
      expected,
      REQUESTS_PAGE_SIZE,
    );
  });

  test("the dashboard shows the latest few requests and says when there are more; each opens for its owner only", async () => {
    const co = await seedCompany(t.db, { ana: {}, bo: {} });
    const other = await seedCompany(t.db, { cy: {} });
    const ctx = createTestContext(t.db);
    const book = (userId: string, n: number, status: "approved" | "pending" | "rejected" = "approved") =>
      t.db
        .insert(schema.leaveRequests)
        .values(
          Array.from({ length: n }, (_, i) => ({
            companyId: co.companyId,
            userId,
            leaveTypeId: co.pto,
            startDate: `2026-12-${String(1 + i).padStart(2, "0")}`,
            endDate: `2026-12-${String(1 + i).padStart(2, "0")}`,
            dayPortion: "full" as const,
            days: 1,
            status,
          })),
        )
        .returning();

    const few = await book(co.people.bo.id, DASHBOARD_REQUESTS);
    const bo = await getDashboard(ctx, co.people.bo);
    assert.deepEqual([bo.requests.length, bo.moreRequests], [DASHBOARD_REQUESTS, false], "exactly the dashboard's worth: nothing more");

    await book(co.people.ana.id, DASHBOARD_REQUESTS + 2);
    const ana = await getDashboard(ctx, co.people.ana);
    assert.deepEqual([ana.requests.length, ana.moreRequests], [DASHBOARD_REQUESTS, true]);
    assert.deepEqual(
      ana.requests.map((r) => r.startDate),
      ["2026-12-07", "2026-12-06", "2026-12-05", "2026-12-04", "2026-12-03"],
      "the latest dates first",
    );

    // A request opens for its owner, with whether it can be cancelled; nobody else's does.
    const mine = await getMyRequest(ctx, co.people.bo, few[0].id);
    assert.deepEqual(
      [mine.request.id, mine.request.cancellable, mine.timezone],
      [few[0].id, true, "America/Chicago"],
      "with the company's zone for its dates",
    );
    await rejectsWith(getMyRequest(ctx, co.people.ana, few[0].id), "not_found");
    await rejectsWith(getMyRequest(ctx, other.people.cy, few[0].id), "not_found");
    await rejectsWith(getMyRequest(ctx, co.people.bo, "not-an-id"), "not_found");
    await cancelLeaveRequest(ctx, co.people.bo, few[0].id);
    const cancelled = await getMyRequest(ctx, co.people.bo, few[0].id);
    assert.deepEqual([cancelled.request.status, cancelled.request.cancellable], ["cancelled", false]);
  });

  test("webhook deliveries: newest first; same instant, then id", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { endpoint } = await createWebhookEndpoint(ctx, co.people.boss, {
      url: "https://hooks.example.com/x",
      description: "",
      eventTypes: ["leave.requested"],
    });
    const at = new Date("2026-10-01T12:00:00.123Z");
    const rows = await t.db
      .insert(schema.webhookDeliveries)
      .values(
        Array.from({ length: DELIVERIES_PAGE_SIZE + 6 }, (_, i) => ({
          companyId: co.companyId,
          endpointId: endpoint.id,
          eventId: randomUUID(),
          eventType: "leave.requested",
          body: "{}",
          nextAttemptAt: at,
          createdAt: new Date(at.getTime() + (i % 3) * 1000),
        })),
      )
      .returning();
    const expected = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || byText(b.id, a.id)).map((r) => r.id);
    await walk(
      async (page) => {
        const e = await getWebhookEndpoint(ctx, co.people.boss, endpoint.id, page);
        return { items: e.deliveries, previous: e.deliveryPages.previous, next: e.deliveryPages.next };
      },
      expected,
      DELIVERIES_PAGE_SIZE,
    );
  });
});

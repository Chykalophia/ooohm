import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { findJob } from "@/server/repositories/scheduled-jobs";
import { pruneIntegrationData } from "@/server/services/retention";
import { DAILY_JOBS, JOB_INTERVAL_MS, JOB_RETRY_MS, runDueJobs } from "@/server/services/scheduled-jobs";
import { createWebhookEndpoint } from "@/server/services/webhooks";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const T0 = new Date("2026-11-02T03:00:00Z");
const DAY = 86_400_000;

describe("worker jobs and retention", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("of several workers claiming at once, exactly one runs a daily job; it is due again a day later", async () => {
    const clock = { now: T0 };
    const ctx = createTestContext(t.db);
    ctx.now = () => clock.now;
    let runs = 0;
    const jobs = {
      counted: async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
        return { runs };
      },
    };
    const ran = await Promise.all([runDueJobs(ctx, jobs), runDueJobs(ctx, jobs), runDueJobs(ctx, jobs), runDueJobs(ctx, jobs)]);
    assert.equal(runs, 1);
    assert.equal(ran.flat().length, 1);
    const row = await findJob(t.db, "counted");
    assert.equal(row?.nextRunAt.getTime(), T0.getTime() + JOB_INTERVAL_MS);
    assert.equal(row?.lastError, null);

    clock.now = new Date(T0.getTime() + JOB_INTERVAL_MS - 1);
    await runDueJobs(ctx, jobs);
    assert.equal(runs, 1, "a restart or another worker does not run it early");
    clock.now = new Date(T0.getTime() + JOB_INTERVAL_MS);
    await runDueJobs(ctx, jobs);
    assert.equal(runs, 2);
  });

  test("a failed run is recorded without parameters and retried an hour later", async () => {
    const clock = { now: T0 };
    const ctx = createTestContext(t.db);
    ctx.now = () => clock.now;
    let attempts = 0;
    const jobs = {
      flaky: async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("secret detail"), { code: "XX000" });
        return {};
      },
    };
    await runDueJobs(ctx, jobs);
    const failed = await findJob(t.db, "flaky");
    assert.equal(failed?.lastError, "Error (XX000)");
    assert.equal(failed?.nextRunAt.getTime(), T0.getTime() + JOB_RETRY_MS);
    clock.now = new Date(T0.getTime() + JOB_RETRY_MS);
    await runDueJobs(ctx, jobs);
    assert.equal(attempts, 2);
    assert.equal((await findJob(t.db, "flaky"))?.lastError, null);
  });

  test("the worker's daily jobs are the year rollover and retention, and both run", async () => {
    assert.deepEqual(Object.keys(DAILY_JOBS), ["year_rollover", "integration_retention"]);
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    await t.db.update(schema.leaveTypes).set({ defaultAllowanceDays: 15 }).where(eq(schema.leaveTypes.id, co.pto));
    const ctx = createTestContext(t.db, { now: new Date("2027-01-02T12:00:00Z") });
    assert.deepEqual(await runDueJobs(ctx), ["year_rollover", "integration_retention"]);
    const rows = await t.db.select().from(schema.allowances).where(eq(schema.allowances.userId, co.people.boss.id));
    assert.ok(rows.some((r) => r.year === 2027 && r.days === 15), "the rollover created this year's allowance");
    assert.deepEqual(await runDueJobs(ctx), [], "not again the same day");
  });

  test("retention prunes finished deliveries and dispatched events older than 90 days, and nothing pending", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { endpoint } = await createWebhookEndpoint(ctx, co.people.boss, { url: "https://hooks.example.com/x", description: "", eventTypes: ["leave.requested"] });
    const now = new Date("2027-03-01T00:00:00Z");
    const old = new Date(now.getTime() - 91 * DAY);
    const recent = new Date(now.getTime() - 89 * DAY);
    const [oldDispatched, oldUndispatched, recentDispatched] = await t.db
      .insert(schema.eventsOutbox)
      .values([
        { companyId: co.companyId, type: "leave.requested", payload: {}, createdAt: old, deliveredAt: old },
        { companyId: co.companyId, type: "leave.requested", payload: {}, createdAt: old },
        { companyId: co.companyId, type: "leave.requested", payload: {}, createdAt: recent, deliveredAt: recent },
      ])
      .returning();
    const delivery = (eventId: string, status: "delivered" | "failed" | "pending", at: Date) => ({
      companyId: co.companyId,
      endpointId: endpoint.id,
      eventId,
      eventType: "leave.requested",
      body: "{}",
      status,
      nextAttemptAt: at,
      updatedAt: at,
    });
    await t.db.insert(schema.webhookDeliveries).values([
      delivery(oldDispatched.id, "delivered", old),
      delivery(oldUndispatched.id, "pending", old),
      delivery(recentDispatched.id, "failed", recent),
    ]);
    const blocking = await t.db
      .insert(schema.eventsOutbox)
      .values({ companyId: co.companyId, type: "leave.requested", payload: {}, createdAt: old, deliveredAt: old })
      .returning();
    await t.db.insert(schema.adapterDeliveries).values({ companyId: co.companyId, adapterId: "someday", eventId: blocking[0].id, nextAttemptAt: old });

    const pruned = await pruneIntegrationData(ctx, { now });
    assert.deepEqual(pruned, { webhookDeliveries: 1, adapterDeliveries: 0, events: 1 });
    const left = await t.db.select({ id: schema.eventsOutbox.id }).from(schema.eventsOutbox).where(eq(schema.eventsOutbox.companyId, co.companyId));
    const ids = new Set(left.map((r) => r.id));
    assert.ok(!ids.has(oldDispatched.id));
    assert.ok(ids.has(oldUndispatched.id), "never dispatched: kept");
    assert.ok(ids.has(recentDispatched.id), "younger than 90 days: kept");
    assert.ok(ids.has(blocking[0].id), "an adapter still owes it: kept");
    const deliveries = await t.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.endpointId, endpoint.id));
    assert.deepEqual(deliveries.map((d) => d.status).sort(), ["failed", "pending"]);
  });
});

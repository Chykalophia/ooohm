import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { EventEnvelope } from "@/domain/integrations";
import type { WebhookFetch } from "@/lib/safe-fetch";
import { runTick } from "@/server/services/background-tick";
import { setAllowanceOverride } from "@/server/services/admin-allowances";
import { cancelLeaveRequest, submitLeaveRequest } from "@/server/services/leave-requests";
import { runDueJobs } from "@/server/services/scheduled-jobs";
import { createWebhookEndpoint } from "@/server/services/webhooks";
import { rejectsWith } from "./assertions";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestContext, type TestDatabase } from "./harness";

const T0 = new Date("2026-11-02T15:00:00Z");

/** A fake webhook transport: records each event type it is sent and answers with `status()`. */
function receiver(status: () => number = () => 200) {
  const received: string[] = [];
  const fetch: WebhookFetch = async (_url, init) => {
    received.push((JSON.parse(init.body) as EventEnvelope).type);
    return new Response("ok", { status: status() });
  };
  return { fetch, received };
}

describe("background tick: one bounded pass, inline after a change, safe to run at once", { skip }, () => {
  let t: TestDatabase;
  let ctx: TestContext;
  const clock = { now: T0 };

  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    // Nothing left over from another test to dispatch or deliver; daily jobs not due.
    await t.db.update(schema.eventsOutbox).set({ deliveredAt: T0 }).where(sql`${schema.eventsOutbox.deliveredAt} is null`);
    await t.db.update(schema.webhookDeliveries).set({ status: "cancelled" }).where(eq(schema.webhookDeliveries.status, "pending"));
    clock.now = T0;
    ctx = createTestContext(t.db);
    ctx.now = () => clock.now;
    await runDueJobs(ctx);
  });

  async function companyWithEndpoint(eventTypes: string[]) {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const url = `https://hooks-${randomUUID().slice(0, 8)}.example.com/in`;
    const { endpoint } = await createWebhookEndpoint(ctx, co.people.boss, { url, description: "", eventTypes });
    await ctx.settle();
    // The endpoint's own `webhook_endpoint.created` is not what these tests are about.
    await t.db.update(schema.eventsOutbox).set({ deliveredAt: T0 }).where(sql`${schema.eventsOutbox.deliveredAt} is null`);
    return { co, endpoint };
  }

  test("inline mode: a change that wrote events wakes a tick after commit, which delivers its webhook", async () => {
    const { co } = await companyWithEndpoint(["leave.requested"]);
    const { fetch, received } = receiver();
    let wakes = 0;
    ctx.wake = async () => {
      wakes++;
      await runTick(ctx, { fetch });
    };

    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-09", dayPortion: "full" });
    assert.equal(wakes, 0, "nothing runs before the response (after())");
    assert.deepEqual(received, []);
    await ctx.settle();
    assert.equal(wakes, 1);
    assert.deepEqual(received, ["leave.requested"]);
  });

  test("inline mode: a refused or rolled-back change wakes nothing", async () => {
    const { co } = await companyWithEndpoint(["leave.requested"]);
    let wakes = 0;
    ctx.wake = async () => void wakes++;
    await rejectsWith(cancelLeaveRequest(ctx, co.people.ana, randomUUID()), "not_found");
    await rejectsWith(submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-07", dayPortion: "full" }), "zero_days");
    await ctx.settle();
    assert.equal(wakes, 0);
  });

  test("inline mode reaches admin changes too, not only those that send email", async () => {
    const { co } = await companyWithEndpoint(["balance.adjusted"]);
    const { fetch, received } = receiver();
    ctx.wake = async () => void (await runTick(ctx, { fetch }));
    await setAllowanceOverride(ctx, co.people.boss, { userId: co.people.ana.id, leaveTypeId: co.pto, year: 2026, days: 12, adjustmentDays: 0, reason: "contract" });
    await ctx.settle();
    assert.deepEqual(received, ["balance.adjusted"]);
  });

  test("a tick delivers a retry once it is due, and not before", async () => {
    const { co, endpoint } = await companyWithEndpoint(["leave.requested"]);
    let status = 503;
    const { fetch, received } = receiver(() => status);
    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-10", dayPortion: "full" });

    const first = await runTick(ctx, { fetch });
    assert.deepEqual([first.events, first.webhooks.attempted, first.webhooks.retried], [1, 1, 1]);
    status = 200;
    const early = await runTick(ctx, { fetch });
    assert.equal(early.webhooks.attempted, 0, "the retry waits for its time");

    clock.now = new Date(T0.getTime() + 2 * 60_000); // past the first retry's 1 minute (±10%)
    const due = await runTick(ctx, { fetch });
    assert.deepEqual([due.webhooks.attempted, due.webhooks.delivered], [1, 1]);
    assert.deepEqual(received, ["leave.requested", "leave.requested"]);
    const [delivery] = await t.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.endpointId, endpoint.id));
    assert.deepEqual([delivery.status, delivery.attempts], ["delivered", 2]);
  });

  test("ticks run at once deliver every event exactly once", async () => {
    const { co } = await companyWithEndpoint(["leave.requested"]);
    const { fetch, received } = receiver();
    const dates = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11"];
    for (const d of dates) await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: d, dayPortion: "full" });

    const runs = await Promise.all([runTick(ctx, { fetch }), runTick(ctx, { fetch }), runTick(ctx, { fetch })]);
    assert.equal(runs.reduce((n, r) => n + r.events, 0), dates.length, "each event dispatched by one tick");
    assert.equal(runs.reduce((n, r) => n + r.webhooks.delivered, 0), dates.length);
    assert.equal(received.length, dates.length, "and sent once");
  });

  test("the budget bounds a tick: once it has run out, no new work starts and the summary says so", async () => {
    const { co } = await companyWithEndpoint(["leave.requested"]);
    const { fetch, received } = receiver();
    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-12", dayPortion: "full" });
    let elapsed = 0;
    // Every clock reading costs 1 s; a 2 s budget lets dispatch run once, then stops.
    const tick = await runTick(ctx, { fetch, budgetMs: 2_000, monotonicNow: () => (elapsed += 1_000) });
    assert.equal(tick.events, 1);
    assert.equal(tick.webhooks.attempted, 0);
    assert.equal(tick.stoppedEarly, true);
    assert.deepEqual(received, []);
    const next = await runTick(ctx, { fetch });
    assert.deepEqual([next.webhooks.delivered, next.stoppedEarly], [1, false], "the next tick picks up the rest");
  });

  test("a due daily job runs in the tick, once a day however many ticks run", async () => {
    const { fetch } = receiver();
    clock.now = new Date(T0.getTime() + 25 * 3_600_000);
    const [a, b] = await Promise.all([runTick(ctx, { fetch, steps: ["jobs"] }), runTick(ctx, { fetch, steps: ["jobs"] })]);
    assert.equal(a.jobs + b.jobs, 3, "every daily job ran, each by one tick");
    assert.equal((await runTick(ctx, { fetch })).jobs, 0, "not again the same day");
  });
});

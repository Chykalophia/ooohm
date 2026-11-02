import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { EventEnvelope } from "@/domain/integrations";
import { RETRY_DELAYS_MS } from "@/domain/integrations";
import { type Adapter, adapterRegistry, createAdapterRegistry, type InboundBalance, type InboundUser } from "@/server/integrations/adapter";
import { deliverDueAdapterEvents } from "@/server/services/adapter-delivery";
import { applyInboundSync } from "@/server/services/inbound-sync";
import { listAdapters, syncAdapterNow } from "@/server/services/integrations";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { dispatchOutboxBatch } from "@/server/services/outbox-dispatch";
import { createWebhookEndpoint } from "@/server/services/webhooks";
import { rejectsWith } from "./assertions";
import { allowancesOf, companyAudit, companyEvents, seedCompany, setAllowance } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const T0 = new Date("2026-11-02T15:00:00Z");

/** A test-only adapter: records what it is sent, fails while `down`, and syncs what it is given. */
function fakeAdapter(options: { users?: InboundUser[]; balances?: InboundBalance[]; healthy?: boolean } = {}) {
  const received: EventEnvelope[] = [];
  const state = { down: false };
  const adapter: Adapter = {
    id: "fakehr",
    displayName: "Fake HR",
    handles: (type) => type.startsWith("leave."),
    async deliver(event) {
      if (state.down) throw new Error("Fake HR is down");
      received.push(event);
    },
    syncUsers: async () => options.users ?? [],
    syncBalances: async () => options.balances ?? [],
    healthCheck: async () => (options.healthy === false ? { ok: false, detail: "Token rejected." } : { ok: true, detail: "Connected." }),
  };
  return { adapter, received, state };
}

describe("adapter seam", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.update(schema.eventsOutbox).set({ deliveredAt: T0 }).where(sql`${schema.eventsOutbox.deliveredAt} is null`);
    await t.db.update(schema.adapterDeliveries).set({ status: "cancelled" }).where(eq(schema.adapterDeliveries.status, "pending"));
  });

  const company = () => seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });

  test("v1 registers no adapters: nothing is delivered to one, and the screen has nothing to list", async () => {
    assert.deepEqual(adapterRegistry.list(), []);
    const co = await company();
    const ctx = createTestContext(t.db, { now: T0, adapters: adapterRegistry });
    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-09", endDate: "2026-11-09", dayPortion: "full" });
    assert.equal((await dispatchOutboxBatch(ctx)).adapterDeliveries, 0);
    assert.equal((await t.db.select().from(schema.adapterDeliveries)).length, 0);
    assert.deepEqual(await listAdapters(ctx, co.people.boss), []);
  });

  test("outbound: a registered adapter receives the events it handles as envelopes, retried on the webhook schedule", async () => {
    const co = await company();
    const fake = fakeAdapter();
    const ctx = createTestContext(t.db, { now: T0, adapters: createAdapterRegistry([fake.adapter]) });
    const request = await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-09", endDate: "2026-11-09", dayPortion: "full" });
    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: co.pto, year: 2026, days: 10 });
    const dispatched = await dispatchOutboxBatch(ctx);
    assert.equal(dispatched.adapterDeliveries, 1, "leave.requested only; it does not handle other types");

    fake.state.down = true;
    const clock = { now: T0 };
    const deps = { now: () => clock.now, random: () => 0.5 };
    assert.deepEqual(await deliverDueAdapterEvents(ctx, deps), { attempted: 1, delivered: 0, retried: 1, failed: 0 });
    let [row] = await t.db.select().from(schema.adapterDeliveries).where(eq(schema.adapterDeliveries.adapterId, "fakehr"));
    assert.equal(row.status, "pending");
    assert.equal(row.lastError, "Error");
    assert.equal(row.nextAttemptAt.getTime() - T0.getTime(), RETRY_DELAYS_MS[0]);
    assert.equal((await deliverDueAdapterEvents(ctx, deps)).attempted, 0, "not before the retry is due");

    fake.state.down = false;
    clock.now = row.nextAttemptAt;
    assert.deepEqual(await deliverDueAdapterEvents(ctx, deps), { attempted: 1, delivered: 1, retried: 0, failed: 0 });
    [row] = await t.db.select().from(schema.adapterDeliveries).where(eq(schema.adapterDeliveries.id, row.id));
    assert.equal(row.status, "delivered");
    assert.equal(row.attempts, 2);
    assert.equal(fake.received.length, 1);
    const [envelope] = fake.received;
    assert.equal(envelope.type, "leave.requested");
    assert.equal(envelope.version, 1);
    assert.equal(envelope.companyId, co.companyId);
    assert.equal((envelope.data as { requestId: string }).requestId, request.id);
  });

  test("outbound: after the 8th failed attempt the delivery fails; an unregistered adapter's deliveries fail their attempts too", async () => {
    const co = await company();
    const fake = fakeAdapter();
    fake.state.down = true;
    const ctx = createTestContext(t.db, { now: T0, adapters: createAdapterRegistry([fake.adapter]) });
    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-10", endDate: "2026-11-10", dayPortion: "full" });
    await dispatchOutboxBatch(ctx);
    const clock = { now: T0 };
    for (let i = 0; i < 8; i++) {
      await deliverDueAdapterEvents(ctx, { now: () => clock.now });
      clock.now = new Date(clock.now.getTime() + 2 * 86_400_000);
    }
    const [row] = await t.db.select().from(schema.adapterDeliveries).where(eq(schema.adapterDeliveries.companyId, co.companyId));
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 8);

    // The adapter is removed from the registry: its queued deliveries wait for it, failing their attempts.
    await t.db.update(schema.adapterDeliveries).set({ status: "pending", attempts: 0, nextAttemptAt: T0 }).where(eq(schema.adapterDeliveries.id, row.id));
    const without = createTestContext(t.db, { now: T0, adapters: createAdapterRegistry() });
    assert.equal((await deliverDueAdapterEvents(without, { now: () => T0 })).retried, 1);
    const [after] = await t.db.select().from(schema.adapterDeliveries).where(eq(schema.adapterDeliveries.id, row.id));
    assert.equal(after.lastError, "adapter_not_registered");
  });

  test("outbound: a slow adapter with two workers polling gets exactly one call per delivery, even past the lease", async () => {
    const co = await company();
    const calls = new Map<string, number>();
    const clock = { now: T0 };
    const slow: Adapter = {
      id: "slowhr",
      displayName: "Slow HR",
      handles: (type) => type === "leave.requested",
      async deliver(event) {
        calls.set(event.id, (calls.get(event.id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 5));
        clock.now = new Date(clock.now.getTime() + 35_000); // each call "takes" 35 s: 4 calls outlast a 2-minute lease
      },
      healthCheck: async () => ({ ok: true }),
    };
    const ctx = createTestContext(t.db, { now: T0, adapters: createAdapterRegistry([slow]) });
    const days = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16"];
    for (const day of days) await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: day, endDate: day, dayPortion: "full" });
    assert.equal((await dispatchOutboxBatch(ctx)).adapterDeliveries, days.length);

    const deps = { now: () => clock.now, random: () => 0.5 };
    let firstDone = false;
    const first = deliverDueAdapterEvents(ctx, deps).finally(() => (firstDone = true));
    const second = (async () => {
      let attempted = 0;
      while (!firstDone) {
        attempted += (await deliverDueAdapterEvents(ctx, deps)).attempted;
        await new Promise((r) => setTimeout(r, 1));
      }
      return attempted;
    })();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.attempted + b, days.length, "each delivery claimed by exactly one worker");
    assert.equal(calls.size, days.length);
    assert.ok([...calls.values()].every((n) => n === 1), `one call each, got ${JSON.stringify([...calls.values()])}`);
    const rows = await t.db.select().from(schema.adapterDeliveries).where(eq(schema.adapterDeliveries.adapterId, "slowhr"));
    assert.ok(rows.every((r) => r.status === "delivered" && r.attempts === 1), "no attempt spent on a re-claim");
  });

  test("outbound: on shutdown the call in flight sees its signal abort and is released, not failed, even on its last attempt", async () => {
    const co = await company();
    const stop = new AbortController();
    let sawAbort = false;
    const stuck: Adapter = {
      id: "stuckhr",
      displayName: "Stuck HR",
      handles: (type) => type === "leave.requested",
      deliver: (_event, actx) =>
        new Promise<void>((_resolve, reject) => {
          actx.signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted"));
          });
          setTimeout(() => stop.abort(), 5); // SIGTERM while the call hangs
        }),
      healthCheck: async () => ({ ok: true }),
    };
    const ctx = createTestContext(t.db, { now: T0, adapters: createAdapterRegistry([stuck]) });
    for (const day of ["2026-11-17", "2026-11-18"]) await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: day, endDate: day, dayPortion: "full" });
    await dispatchOutboxBatch(ctx);
    // Seven attempts already failed: the 8th is the last one the schedule allows.
    await t.db.update(schema.adapterDeliveries).set({ attempts: 7, lastError: "Error" }).where(eq(schema.adapterDeliveries.adapterId, "stuckhr"));

    const later = new Date(T0.getTime() + 1_000);
    const clock = { now: T0 };
    const run = await deliverDueAdapterEvents(ctx, { now: () => clock.now, random: () => 0.5, signal: stop.signal });
    assert.deepEqual(run, { attempted: 0, delivered: 0, retried: 0, failed: 0 }, "a stopped call is not an attempt");
    assert.ok(sawAbort, "the adapter saw AdapterContext.signal abort");
    const rows = await t.db.select().from(schema.adapterDeliveries).where(eq(schema.adapterDeliveries.adapterId, "stuckhr"));
    assert.deepEqual(
      rows.map((r) => [r.status, r.attempts, r.lastError]),
      [
        ["pending", 7, "Error"],
        ["pending", 7, "Error"],
      ],
      "both still pending with seven attempts: the interrupted one was handed back, the other never claimed",
    );
    assert.ok(rows.every((r) => r.nextAttemptAt.getTime() <= T0.getTime()), "due again at once");

    // The next worker takes it straight away, and a real failure still ends it as failed.
    clock.now = later;
    const fails: Adapter = { ...stuck, deliver: async () => Promise.reject(new Error("down")) };
    const next = createTestContext(t.db, { now: later, adapters: createAdapterRegistry([fails]) });
    assert.deepEqual(await deliverDueAdapterEvents(next, { now: () => later, limit: 1 }), { attempted: 1, delivered: 0, retried: 0, failed: 1 });
  });

  test("outbound: a stop that lands between the claim and the call never calls the adapter, and spends no attempt", { timeout: 10_000 }, async () => {
    const co = await company();
    const stop = new AbortController();
    let calls = 0;
    const deaf: Adapter = {
      id: "deafhr",
      displayName: "Deaf HR",
      handles: (type) => type === "leave.requested",
      deliver: () => {
        calls++;
        return new Promise<void>(() => {}); // never settles, never looks at its signal
      },
      healthCheck: async () => ({ ok: true }),
    };
    const ctx = createTestContext(t.db, { now: T0, adapters: createAdapterRegistry([deaf]) });
    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-20", endDate: "2026-11-20", dayPortion: "full" });
    await dispatchOutboxBatch(ctx);
    // The clock is read right after the "is it stopped?" check and before the claim: abort there.
    let reads = 0;
    const now = () => {
      if (++reads === 1) stop.abort();
      return T0;
    };
    const run = await deliverDueAdapterEvents(ctx, { now, random: () => 0.5, signal: stop.signal, timeoutMs: 60_000 });
    assert.deepEqual(run, { attempted: 0, delivered: 0, retried: 0, failed: 0 });
    assert.equal(calls, 0, "the adapter is never called after the stop");
    const [row] = await t.db.select().from(schema.adapterDeliveries).where(eq(schema.adapterDeliveries.adapterId, "deafhr"));
    assert.deepEqual([row.status, row.attempts, row.lastError], ["pending", 0, null]);
    assert.equal(row.nextAttemptAt.getTime(), T0.getTime(), "due again at once");
  });

  test("outbound: without a stop, a failed call still spends its attempt (paired with the two above)", async () => {
    const co = await company();
    const stop = new AbortController();
    const fails: Adapter = {
      id: "failhr",
      displayName: "Fail HR",
      handles: (type) => type === "leave.requested",
      deliver: async () => Promise.reject(new Error("down")),
      healthCheck: async () => ({ ok: true }),
    };
    const ctx = createTestContext(t.db, { now: T0, adapters: createAdapterRegistry([fails]) });
    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-23", endDate: "2026-11-23", dayPortion: "full" });
    await dispatchOutboxBatch(ctx);
    const run = await deliverDueAdapterEvents(ctx, { now: () => T0, random: () => 0.5, signal: stop.signal });
    assert.deepEqual(run, { attempted: 1, delivered: 0, retried: 1, failed: 0 });
    const [row] = await t.db.select().from(schema.adapterDeliveries).where(eq(schema.adapterDeliveries.adapterId, "failhr"));
    assert.deepEqual([row.status, row.attempts, row.lastError], ["pending", 1, "Error"]);
  });

  test("dispatch: handles() gets the company; one that throws counts as no and never stalls webhooks or other adapters", async () => {
    const co = await company();
    const other = await company();
    const ctx = createTestContext(t.db, { now: T0 });
    const { endpoint } = await createWebhookEndpoint(ctx, co.people.boss, { url: "https://hooks.example.com/ooohm", description: "", eventTypes: ["leave.requested"] });
    const seen: string[] = [];
    const onlyFirst: Adapter = {
      id: "onlyfirst",
      displayName: "Connected by one company",
      handles: (type, companyId) => (seen.push(companyId), type === "leave.requested" && companyId === co.companyId),
      deliver: async () => {},
      healthCheck: async () => ({ ok: true }),
    };
    const faulty: Adapter = {
      id: "faulty",
      displayName: "Faulty",
      handles: () => {
        throw new Error("boom");
      },
      deliver: async () => {},
      healthCheck: async () => ({ ok: true }),
    };
    const dispatching = createTestContext(t.db, { now: T0, adapters: createAdapterRegistry([faulty, onlyFirst]) });
    await submitLeaveRequest(dispatching, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-19", endDate: "2026-11-19", dayPortion: "full" });
    await submitLeaveRequest(dispatching, other.people.ana, { leaveTypeId: other.pto, startDate: "2026-11-19", endDate: "2026-11-19", dayPortion: "full" });

    const result = await dispatchOutboxBatch(dispatching);
    assert.equal(result.webhookDeliveries, 1, "the webhook still gets its delivery");
    assert.equal(result.adapterDeliveries, 1, "only the company that connected the adapter");
    assert.equal((await t.db.select().from(schema.eventsOutbox).where(sql`${schema.eventsOutbox.deliveredAt} is null`)).length, 0, "every event dispatched");
    const [row] = await t.db.select().from(schema.adapterDeliveries).where(eq(schema.adapterDeliveries.adapterId, "onlyfirst"));
    assert.equal(row.companyId, co.companyId);
    assert.ok(seen.includes(other.companyId), "asked about the other company too");
    assert.equal((await t.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.endpointId, endpoint.id))).length, 1);
  });

  test("inbound: people are created inactive (invite-only), renamed when known, and skipped when another company's; all audited", async () => {
    const co = await company();
    const other = await company();
    const ctx = createTestContext(t.db, { now: T0 });
    const result = await applyInboundSync(ctx, {
      companyId: co.companyId,
      adapterId: "fakehr",
      actor: null,
      users: [
        { email: "  New.Person@Example.com ", name: "New Person" },
        { email: co.people.ana.email, name: "Ana Renamed" },
        { email: co.people.boss.email, name: co.people.boss.name },
        { email: other.people.ana.email, name: "Not Yours" },
        { email: "not-an-email", name: "Broken" },
      ],
    });
    assert.deepEqual(result.users, {
      created: 1,
      updated: 1,
      unchanged: 1,
      skipped: [
        { email: other.people.ana.email, reason: "other_company" },
        { email: "not-an-email", reason: "invalid" },
      ],
    });
    const [created] = await t.db.select().from(schema.user).where(eq(schema.user.email, "new.person@example.com"));
    assert.equal(created.companyId, co.companyId);
    assert.equal(created.isActive, false, "waits for an admin to activate them");
    assert.equal(created.role, "employee");
    assert.equal((await t.db.select().from(schema.session).where(eq(schema.session.userId, created.id))).length, 0, "no session");
    assert.equal(ctx.sent.length + ctx.signInLinks.length, 0, "no email, no sign-in link");
    const [renamed] = await t.db.select().from(schema.user).where(eq(schema.user.id, co.people.ana.id));
    assert.equal(renamed.name, "Ana Renamed");
    const [untouched] = await t.db.select().from(schema.user).where(eq(schema.user.id, other.people.ana.id));
    assert.notEqual(untouched.name, "Not Yours");

    const audits = await companyAudit(t.db, co.companyId, "user.");
    assert.deepEqual(audits.map((a) => a.action), ["user.created", "user.updated"]);
    assert.ok(audits.every((a) => a.actorId === null && (a.after as { source: string }).source === "adapter:fakehr"));
    const events = await companyEvents(t.db, co.companyId, "user.");
    assert.deepEqual(events.map((e) => e.type), ["user.created", "user.updated"]);
    assert.equal((events[0].payload as { isActive: boolean; actorId: string | null }).isActive, false);
    assert.equal((events[0].payload as { actorId: string | null }).actorId, null);

    const active = await applyInboundSync(ctx, { companyId: co.companyId, adapterId: "fakehr", actor: null, activateNewUsers: true, users: [{ email: "second@example.com", name: "Second" }] });
    assert.equal(active.users.created, 1);
    const [second] = await t.db.select().from(schema.user).where(eq(schema.user.email, "second@example.com"));
    assert.equal(second.isActive, true, "the flag lets them ask for a sign-in link themselves");
  });

  test("inbound: allowances are set under the member lock with audit and balance.adjusted (reason sync); bad rows are skipped", async () => {
    const co = await company();
    const ctx = createTestContext(t.db, { now: T0 });
    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: co.pto, year: 2026, days: 10, adjustmentDays: 2 });
    const result = await applyInboundSync(ctx, {
      companyId: co.companyId,
      adapterId: "fakehr",
      actor: co.people.boss,
      balances: [
        { email: co.people.ana.email, leaveTypeCode: "pto", year: 2026, days: 20 },
        { email: co.people.ana.email, leaveTypeCode: "PTO", year: 2027, days: 18, adjustmentDays: -1 },
        { email: co.people.ana.email, leaveTypeCode: "PTO", year: 2026, days: 20 },
        { email: "nobody@example.com", leaveTypeCode: "PTO", year: 2026, days: 5 },
        { email: co.people.ana.email, leaveTypeCode: "NOPE", year: 2026, days: 5 },
        { email: co.people.ana.email, leaveTypeCode: "PTO", year: 2020, days: 5 },
        { email: co.people.ana.email, leaveTypeCode: "PTO", year: 2026, days: 5.25 },
      ],
    });
    assert.equal(result.balances.changed, 2);
    assert.equal(result.balances.unchanged, 1);
    assert.deepEqual(
      result.balances.skipped.map((s) => s.reason),
      ["unknown_person", "unknown_leave_type", "closed_year", "invalid"],
    );
    assert.deepEqual(
      (await allowancesOf(t.db, co.people.ana.id)).map((a) => [a.year, a.days, a.adjustmentDays]),
      [
        [2026, 20, 2],
        [2027, 18, -1],
      ],
      "an omitted adjustment keeps the existing one",
    );
    const audits = await companyAudit(t.db, co.companyId, "allowance.synced");
    assert.equal(audits.length, 2);
    assert.equal(audits[0].actorId, co.people.boss.id);
    assert.equal((audits[0].after as { reason: string }).reason, "Synced from adapter:fakehr");
    const events = (await companyEvents(t.db, co.companyId, "balance.adjusted")).map((e) => e.payload as { reason: string; days: number });
    assert.deepEqual(events.map((e) => [e.reason, e.days]), [["sync", 20], ["sync", 18]]);
  });

  test("the admin screen lists adapters with their health, and Sync now applies what the adapter returns", async () => {
    const co = await company();
    const fake = fakeAdapter({ users: [{ email: "synced@example.com", name: "Synced Person" }], balances: [{ email: co.people.ana.email, leaveTypeCode: "PTO", year: 2026, days: 12 }] });
    const broken: Adapter = {
      id: "broken",
      displayName: "Broken",
      handles: () => false,
      deliver: async () => {},
      healthCheck: async () => {
        throw new Error("boom");
      },
    };
    const ctx = createTestContext(t.db, { now: T0, adapters: createAdapterRegistry([fake.adapter, broken]) });
    assert.deepEqual(await listAdapters(ctx, co.people.boss), [
      { id: "fakehr", displayName: "Fake HR", syncs: true, ok: true, detail: "Connected." },
      { id: "broken", displayName: "Broken", syncs: false, ok: false, detail: "The health check failed." },
    ]);
    await rejectsWith(listAdapters(ctx, co.people.ana), "forbidden");
    await rejectsWith(syncAdapterNow(ctx, co.people.ana, "fakehr"), "forbidden");
    await rejectsWith(syncAdapterNow(ctx, co.people.boss, "broken"), "not_found");
    await rejectsWith(syncAdapterNow(ctx, co.people.boss, "missing"), "not_found");

    const result = await syncAdapterNow(ctx, co.people.boss, "fakehr");
    assert.equal(result.users.created, 1);
    assert.equal(result.balances.changed, 1);
    const [person] = await companyAudit(t.db, co.companyId, "user.created");
    assert.equal(person.actorId, co.people.boss.id);
  });

  test("Sync now: an admin deactivated or demoted while the adapter reads is refused before anything is written", async () => {
    const co = await company();
    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: co.pto, year: 2026, days: 10 });
    const auditBefore = (await companyAudit(t.db, co.companyId, "")).length;
    const eventsBefore = (await companyEvents(t.db, co.companyId, "")).length;
    const setBoss = (fields: Partial<typeof schema.user.$inferInsert>) => t.db.update(schema.user).set(fields).where(eq(schema.user.id, co.people.boss.id));

    // Another admin deactivates them during the people read.
    const people: Adapter = {
      id: "peoplehr",
      displayName: "People HR",
      handles: () => false,
      deliver: async () => {},
      syncUsers: async () => {
        await setBoss({ isActive: false });
        return [{ email: "late@example.com", name: "Late" }, { email: co.people.ana.email, name: "Ana Late" }];
      },
      healthCheck: async () => ({ ok: true }),
    };
    // Another admin demotes them during the allowance read.
    const allowances: Adapter = {
      id: "payhr",
      displayName: "Pay HR",
      handles: () => false,
      deliver: async () => {},
      syncBalances: async () => {
        await setBoss({ role: "employee" });
        return [{ email: co.people.ana.email, leaveTypeCode: "PTO", year: 2026, days: 25 }];
      },
      healthCheck: async () => ({ ok: true }),
    };
    const ctx = createTestContext(t.db, { now: T0, adapters: createAdapterRegistry([people, allowances]) });

    await rejectsWith(syncAdapterNow(ctx, co.people.boss, "peoplehr"), "forbidden");
    await setBoss({ isActive: true });
    await rejectsWith(syncAdapterNow(ctx, co.people.boss, "payhr"), "forbidden");

    assert.equal((await t.db.select().from(schema.user).where(eq(schema.user.email, "late@example.com"))).length, 0, "nobody created");
    const [ana] = await t.db.select().from(schema.user).where(eq(schema.user.id, co.people.ana.id));
    assert.equal(ana.name, co.people.ana.name, "nobody renamed");
    assert.deepEqual((await allowancesOf(t.db, co.people.ana.id)).map((a) => a.days), [10], "no allowance changed");
    assert.equal((await companyAudit(t.db, co.companyId, "")).length, auditBefore, "no audit row");
    assert.equal((await companyEvents(t.db, co.companyId, "")).length, eventsBefore, "no event");

    // Paired: an admin still in place when the writes run gets them applied.
    await setBoss({ role: "admin" });
    const steady = createTestContext(t.db, {
      now: T0,
      adapters: createAdapterRegistry([{ ...allowances, syncBalances: async () => [{ email: co.people.ana.email, leaveTypeCode: "PTO", year: 2026, days: 25 }] }]),
    });
    assert.equal((await syncAdapterNow(steady, co.people.boss, "payhr")).balances.changed, 1);
    assert.deepEqual((await allowancesOf(t.db, co.people.ana.id)).map((a) => a.days), [25]);
  });

  test("inbound: an actor from another company is refused", async () => {
    const co = await company();
    const other = await company();
    const ctx = createTestContext(t.db, { now: T0 });
    await rejectsWith(applyInboundSync(ctx, { companyId: co.companyId, adapterId: "fakehr", actor: other.people.boss, users: [{ email: "x@example.com", name: "X" }] }), "forbidden");
    assert.equal((await t.db.select().from(schema.user).where(eq(schema.user.email, "x@example.com"))).length, 0);
  });
});

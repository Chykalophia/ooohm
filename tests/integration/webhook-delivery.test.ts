import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createWebhookEndpoint as createWebhookEndpointResult, deleteWebhookEndpoint as deleteWebhookEndpointResult, deliverDueWebhooks, dispatchOutboxBatch, listWebhookEndpoints as listWebhookEndpointsResult, redeliverWebhook as redeliverWebhookResult, RETRY_DELAYS_MS, rotateWebhookSecret as rotateWebhookSecretResult, sendWebhookPing as sendWebhookPingResult, setWebhookEndpointEnabled as setWebhookEndpointEnabledResult } from "@/modules/integrations";
import { type EventEnvelope } from "@/shared/kernel/event-envelope";
import { verifyWebhookSignature } from "@/lib/integration-crypto";
import { TransportError, type WebhookFetch } from "@/lib/safe-fetch";
import { claimDueDeliveries, recordDeliveryOutcome } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import { submitLeaveRequest as submitLeaveRequestResult } from "@/modules/leave";
import { unwrap } from "@/shared/lib/result";
import { companyEvents, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, needsServer, skip, type TestContext, type TestDatabase } from "./harness";
import { first, present } from "../support/present";

// The integrations use cases return a ServiceResult; these tests read the value or the thrown DomainError.
const createWebhookEndpoint = (...args: Parameters<typeof createWebhookEndpointResult>) => createWebhookEndpointResult(...args).then(unwrap);
const deleteWebhookEndpoint = (...args: Parameters<typeof deleteWebhookEndpointResult>) => deleteWebhookEndpointResult(...args).then(unwrap);
const listWebhookEndpoints = (...args: Parameters<typeof listWebhookEndpointsResult>) => listWebhookEndpointsResult(...args).then(unwrap);
const redeliverWebhook = (...args: Parameters<typeof redeliverWebhookResult>) => redeliverWebhookResult(...args).then(unwrap);
const rotateWebhookSecret = (...args: Parameters<typeof rotateWebhookSecretResult>) => rotateWebhookSecretResult(...args).then(unwrap);
const sendWebhookPing = (...args: Parameters<typeof sendWebhookPingResult>) => sendWebhookPingResult(...args).then(unwrap);
const setWebhookEndpointEnabled = (...args: Parameters<typeof setWebhookEndpointEnabledResult>) => setWebhookEndpointEnabledResult(...args).then(unwrap);

const submitLeaveRequest = (...args: Parameters<typeof submitLeaveRequestResult>) => submitLeaveRequestResult(...args).then(unwrap);

const T0 = new Date("2026-11-02T15:00:00Z");

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake transport that records every request and answers with `respond`. */
function recorder(respond: (call: Call, signal: AbortSignal) => Promise<Response> | Response = () => new Response("ok", { status: 200 })) {
  const calls: Call[] = [];
  const fetch: WebhookFetch = async (url, init) => {
    const call = { url, headers: init.headers, body: init.body };
    calls.push(call);
    return respond(call, init.signal);
  };
  return { fetch, calls };
}

const host = () => `https://hooks-${randomUUID().slice(0, 8)}.example.com/ooohm`;

describe("outbox dispatch and webhook delivery", { skip }, () => {
  let t: TestDatabase;
  let ctx: TestContext;
  const clock = { now: T0 };

  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });
  // Each test starts with nothing to dispatch or deliver, so a worker call sees only its own rows.
  beforeEach(async () => {
    await t.db.update(schema.eventsOutbox).set({ deliveredAt: T0 }).where(sql`${schema.eventsOutbox.deliveredAt} is null`);
    await t.db.update(schema.webhookDeliveries).set({ status: "cancelled" }).where(eq(schema.webhookDeliveries.status, "pending"));
    clock.now = T0;
    ctx = createTestContext(t.db, { now: T0 });
    ctx.now = () => clock.now;
  });

  async function company() {
    return seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
  }

  async function endpoint(admin: Parameters<typeof createWebhookEndpoint>[1], eventTypes: string[], url = host()) {
    const { endpoint, secret } = await createWebhookEndpoint(ctx, admin, { url, description: "", eventTypes });
    return { ...endpoint, secret };
  }

  async function deliveriesOf(endpointId: string) {
    return t.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.endpointId, endpointId));
  }

  async function submit(co: Awaited<ReturnType<typeof company>>, startDate = "2026-11-09") {
    return submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate, endDate: startDate, dayPortion: "full", note: "Private note" });
  }

  test("a leave request becomes one signed delivery per subscribed endpoint, and nowhere else", async () => {
    const co = await company();
    const other = await company();
    const wanted = await endpoint(co.people.boss, ["leave.requested", "leave.approved"]);
    const balancesOnly = await endpoint(co.people.boss, ["balance.adjusted"]);
    const disabled = await endpoint(co.people.boss, ["leave.requested"]);
    await setWebhookEndpointEnabled(ctx, co.people.boss, disabled.id, false);
    const otherCompany = await endpoint(other.people.boss, ["leave.requested"]);

    const request = await submit(co);
    const dispatched = await dispatchOutboxBatch(ctx);
    assert.equal(dispatched.webhookDeliveries, 1);
    assert.equal((await deliveriesOf(wanted.id)).length, 1);
    for (const e of [balancesOnly, disabled, otherCompany]) assert.equal((await deliveriesOf(e.id)).length, 0);
    assert.equal((await dispatchOutboxBatch(ctx)).events, 0, "every event is dispatched once");

    const { fetch, calls } = recorder();
    const run = await deliverDueWebhooks(ctx, { fetch });
    assert.deepEqual(run, { attempted: 1, delivered: 1, retried: 0, failed: 0 });
    assert.equal(calls.length, 1);
    const call = first(calls);
    assert.equal(call.url, wanted.url);

    const event = first((await companyEvents(t.db, co.companyId, "leave.requested")).filter((e) => (e.payload as { requestId: string }).requestId === request.id));
    const envelope = JSON.parse(call.body) as EventEnvelope<{ requestId: string; days: number }>;
    assert.deepEqual(Object.keys(envelope), ["id", "type", "version", "createdAt", "companyId", "data"]);
    assert.equal(envelope.id, event.id);
    assert.equal(envelope.type, "leave.requested");
    assert.equal(envelope.version, 1);
    assert.equal(envelope.companyId, co.companyId);
    assert.equal(envelope.data.requestId, request.id);
    assert.ok(!call.body.includes("Private note"), "the payload never carries the note");

    assert.equal(call.headers["OOOhm-Event-Id"], event.id);
    assert.equal(call.headers["OOOhm-Event-Type"], "leave.requested");
    assert.equal(present(call.headers["OOOhm-Timestamp"]), String(Math.floor(T0.getTime() / 1000)));
    const verify = (secret: string) =>
      verifyWebhookSignature({
        secret,
        rawBody: call.body,
        timestampHeader: present(call.headers["OOOhm-Timestamp"]),
        signatureHeader: present(call.headers["OOOhm-Signature"]),
        nowSeconds: Math.floor(T0.getTime() / 1000) + 30,
      });
    assert.equal(verify(wanted.secret), true, "signed with the endpoint's secret");
    assert.equal(verify(disabled.secret), false);

    const row = first(await deliveriesOf(wanted.id));
    assert.equal(row.status, "delivered");
    assert.equal(row.attempts, 1);
    const listed = (await listWebhookEndpoints(ctx, co.people.boss)).endpoints;
    assert.deepEqual(
      listed.map((e) => [e.id, e.latest?.status ?? null]),
      [
        [wanted.id, "delivered"],
        [balancesOnly.id, null],
        [disabled.id, null],
      ],
      "the list shows each endpoint's own latest delivery",
    );
    assert.equal(row.lastStatusCode, 200);
    assert.equal(row.lastResponseExcerpt, "ok");
    assert.ok(row.lastLatencyMs !== null && row.lastLatencyMs >= 0);
    assert.deepEqual(row.deliveredAt, T0);
  });

  test("an endpoint never receives events written before it was added", async () => {
    const co = await company();
    await submit(co);
    const late = await endpoint(co.people.boss, ["leave.requested"]);
    await dispatchOutboxBatch(ctx);
    assert.equal((await deliveriesOf(late.id)).length, 0);
    await submit(co, "2026-11-10");
    await dispatchOutboxBatch(ctx);
    assert.equal((await deliveriesOf(late.id)).length, 1);
  });

  test("SKIP LOCKED: a worker passes over events another worker holds, without waiting for it", { skip: needsServer }, async () => {
    const co = await company();
    const e = await endpoint(co.people.boss, ["leave.requested"]);
    await dispatchOutboxBatch(ctx); // the endpoint's own `webhook_endpoint.created`
    for (const d of ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]) await submit(co, d);

    const holder = await t.client.reserve();
    try {
      await holder`begin`;
      const held = await holder`select id from events_outbox where delivered_at is null order by created_at, id limit 2 for update`;
      assert.equal(held.length, 2);
      const result = await Promise.race([
        dispatchOutboxBatch(ctx),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
      ]);
      assert.notEqual(result, "blocked", "the second worker must not wait on the first one's rows");
      assert.equal(result !== "blocked" && result.events, 2, "it takes only the two unlocked events");
      await holder`rollback`;
    } finally {
      holder.release();
    }
    assert.equal((await dispatchOutboxBatch(ctx)).events, 2, "the held events are dispatched once released");
    assert.equal((await deliveriesOf(e.id)).length, 4);
  });

  test("two workers at once: every event dispatched once, every delivery sent once", async () => {
    const co = await company();
    const e = await endpoint(co.people.boss, ["leave.requested"]);
    await dispatchOutboxBatch(ctx); // the endpoint's own `webhook_endpoint.created`
    const events = Array.from({ length: 40 }, () => ({ companyId: co.companyId, type: "leave.requested", payload: { n: 1 } }));
    await t.db.insert(schema.eventsOutbox).values(events);

    const drainDispatch = async () => {
      let total = 0;
      for (;;) {
        const r = await dispatchOutboxBatch(ctx, { limit: 7 });
        if (r.events === 0) return total;
        total += r.events;
      }
    };
    const [a, b] = await Promise.all([drainDispatch(), drainDispatch()]);
    assert.equal(a + b, 40, "no event dispatched by both");
    const rows = await deliveriesOf(e.id);
    assert.equal(rows.length, 40);
    assert.equal(new Set(rows.map((r) => r.eventId)).size, 40);

    const { fetch, calls } = recorder(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return new Response(null, { status: 204 });
    });
    const drainDeliver = async () => {
      for (;;) if ((await deliverDueWebhooks(ctx, { fetch, limit: 6, concurrency: 3 })).attempted === 0) return;
    };
    await Promise.all([drainDeliver(), drainDeliver()]);
    assert.equal(calls.length, 40, "no delivery sent by both");
    assert.equal(new Set(calls.map((c) => c.headers["OOOhm-Event-Id"])).size, 40);
    assert.ok((await deliveriesOf(e.id)).every((r) => r.status === "delivered" && r.attempts === 1));
  });

  test("failures are retried on the schedule (never early), then the delivery fails after the 8th attempt", async () => {
    const co = await company();
    const e = await endpoint(co.people.boss, ["leave.requested"]);
    await submit(co);
    await dispatchOutboxBatch(ctx);
    const { fetch, calls } = recorder(() => new Response("down for maintenance", { status: 503 }));
    const deps = { fetch, now: () => clock.now, random: () => 0.5 };

    for (let attempt = 1; attempt <= 8; attempt++) {
      const run = await deliverDueWebhooks(ctx, deps);
      assert.equal(run.attempted, 1, `attempt ${attempt}`);
      const row = first(await deliveriesOf(e.id));
      assert.equal(row.attempts, attempt);
      assert.equal(row.lastStatusCode, 503);
      assert.equal(row.lastError, "HTTP 503");
      assert.equal(row.lastResponseExcerpt, "down for maintenance");
      if (attempt === 8) {
        assert.equal(row.status, "failed");
        assert.equal(run.failed, 1);
        break;
      }
      assert.equal(row.status, "pending");
      assert.equal(row.nextAttemptAt.getTime() - clock.now.getTime(), RETRY_DELAYS_MS[attempt - 1], `wait after attempt ${attempt}`);
      clock.now = new Date(row.nextAttemptAt.getTime() - 1);
      assert.equal((await deliverDueWebhooks(ctx, deps)).attempted, 0, "not before it is due");
      clock.now = row.nextAttemptAt;
    }
    assert.equal(calls.length, 8);
    clock.now = new Date(clock.now.getTime() + 7 * 86_400_000);
    assert.equal((await deliverDueWebhooks(ctx, deps)).attempted, 0, "a failed delivery is never tried again on its own");
    // Each attempt is signed afresh, with its own timestamp.
    assert.equal(new Set(calls.map((c) => c.headers["OOOhm-Timestamp"])).size, 8);
    assert.equal(new Set(calls.map((c) => c.body)).size, 1, "every attempt carries the same body");
  });

  test("timeouts, refused addresses and redirects are failed attempts with a short error", async () => {
    const co = await company();
    const slow = await endpoint(co.people.boss, ["leave.requested"]);
    const blocked = await endpoint(co.people.boss, ["leave.requested"]);
    const redirect = await endpoint(co.people.boss, ["leave.requested"]);
    await submit(co);
    await dispatchOutboxBatch(ctx);
    const { fetch } = recorder((call, signal) => {
      if (call.url === blocked.url) throw new TransportError("blocked_address");
      if (call.url === redirect.url) return new Response(null, { status: 301, headers: { Location: "https://elsewhere.example.com" } });
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const run = await deliverDueWebhooks(ctx, { fetch, timeoutMs: 50 });
    assert.deepEqual(run, { attempted: 3, delivered: 0, retried: 3, failed: 0 });
    const errorOf = async (id: string) => first(await deliveriesOf(id));
    assert.equal((await errorOf(slow.id)).lastError, "timeout");
    assert.equal((await errorOf(blocked.id)).lastError, "blocked_address");
    assert.equal((await errorOf(redirect.id)).lastError, "HTTP 301");
    for (const e of [slow, blocked, redirect]) assert.equal((await errorOf(e.id)).status, "pending");
  });

  test("redeliver: a failed delivery goes again with the same event id and body, a fresh count, and an audit trail", async () => {
    const co = await company();
    const e = await endpoint(co.people.boss, ["leave.requested"]);
    await submit(co);
    await dispatchOutboxBatch(ctx);
    let up = false;
    const { fetch, calls } = recorder(() => new Response(null, { status: up ? 200 : 500 }));
    for (let i = 0; i < 8; i++) {
      await deliverDueWebhooks(ctx, { fetch, now: () => clock.now });
      clock.now = new Date(clock.now.getTime() + 2 * 86_400_000);
    }
    const failed = first(await deliveriesOf(e.id));
    assert.equal(failed.status, "failed");

    await assert.rejects(redeliverWebhook(ctx, co.people.ana, e.id, failed.id), /forbidden/);
    up = true;
    await redeliverWebhook(ctx, co.people.boss, e.id, failed.id);
    const queued = first(await deliveriesOf(e.id));
    assert.equal(queued.status, "pending");
    assert.equal(queued.attempts, 0);
    assert.equal(queued.lastError, null);
    await assert.rejects(redeliverWebhook(ctx, co.people.boss, e.id, failed.id), /conflict/, "already queued");

    await deliverDueWebhooks(ctx, { fetch, now: () => clock.now });
    const done = first(await deliveriesOf(e.id));
    assert.equal(done.status, "delivered");
    assert.equal(done.attempts, 1);
    assert.equal(calls.at(-1)!.headers["OOOhm-Event-Id"], first(calls).headers["OOOhm-Event-Id"]);
    assert.equal(calls.at(-1)!.body, first(calls).body);

    const event = first(await companyEvents(t.db, co.companyId, "webhook_delivery.redelivered"));
    assert.deepEqual(event.payload, { endpointId: e.id, deliveryId: failed.id, eventId: failed.eventId, eventType: "leave.requested", actorId: co.people.boss.id, actor: { type: "user", id: co.people.boss.id } });
  });

  test("ping: one test event to one endpoint whatever it subscribes to, signed like any delivery", async () => {
    const co = await company();
    const e = await endpoint(co.people.boss, ["balance.adjusted"]);
    const other = await endpoint(co.people.boss, ["balance.adjusted"]);
    const deliveryId = await sendWebhookPing(ctx, co.people.boss, e.id);
    const { fetch, calls } = recorder();
    await deliverDueWebhooks(ctx, { fetch });
    assert.equal(calls.length, 1);
    assert.equal(first(calls).url, e.url);
    assert.equal(first(calls).headers["OOOhm-Event-Type"], "ping");
    const envelope = JSON.parse(first(calls).body) as EventEnvelope<{ endpointId: string }>;
    assert.equal(envelope.type, "ping");
    assert.equal(envelope.data.endpointId, e.id);
    assert.ok(verifyWebhookSignature({ secret: e.secret, rawBody: first(calls).body, timestampHeader: present(first(calls).headers["OOOhm-Timestamp"]), signatureHeader: present(first(calls).headers["OOOhm-Signature"]), nowSeconds: T0.getTime() / 1000 }));
    const row = first(await deliveriesOf(e.id));
    assert.equal(row.id, deliveryId);
    assert.equal(row.status, "delivered");
    assert.equal((await deliveriesOf(other.id)).length, 0);
    const pinged = first(await companyEvents(t.db, co.companyId, "webhook_endpoint.pinged"));
    assert.equal((pinged.payload as { endpointId: string }).endpointId, e.id);
  });

  test("after a rotation, every attempt (retries of older events too) is signed with the new secret only", async () => {
    const co = await company();
    const e = await endpoint(co.people.boss, ["leave.requested"]);
    await submit(co);
    await dispatchOutboxBatch(ctx);
    const failing = recorder(() => new Response(null, { status: 500 }));
    await deliverDueWebhooks(ctx, { fetch: failing.fetch });
    const { secret } = await rotateWebhookSecret(ctx, co.people.boss, e.id);
    assert.notEqual(secret, e.secret);
    clock.now = new Date(T0.getTime() + 3_600_000);
    const { fetch, calls } = recorder();
    await deliverDueWebhooks(ctx, { fetch });
    const check = (s: string) =>
      verifyWebhookSignature({ secret: s, rawBody: first(calls).body, timestampHeader: present(first(calls).headers["OOOhm-Timestamp"]), signatureHeader: present(first(calls).headers["OOOhm-Signature"]), nowSeconds: clock.now.getTime() / 1000 });
    assert.equal(check(secret), true);
    assert.equal(check(e.secret), false);
  });

  test("a disabled endpoint's queued deliveries wait and resume; a deleted one's are cancelled", async () => {
    const co = await company();
    const paused = await endpoint(co.people.boss, ["leave.requested"]);
    const removed = await endpoint(co.people.boss, ["leave.requested"]);
    await submit(co);
    await dispatchOutboxBatch(ctx);
    await setWebhookEndpointEnabled(ctx, co.people.boss, paused.id, false);
    assert.equal(await deleteWebhookEndpoint(ctx, co.people.boss, removed.id), 1);
    const { fetch, calls } = recorder();
    assert.equal((await deliverDueWebhooks(ctx, { fetch })).attempted, 0);
    assert.equal(first(await deliveriesOf(paused.id)).status, "pending");
    assert.equal(first(await deliveriesOf(removed.id)).status, "cancelled");
    await setWebhookEndpointEnabled(ctx, co.people.boss, paused.id, true);
    await deliverDueWebhooks(ctx, { fetch });
    assert.deepEqual(
      calls.map((c) => c.url),
      [paused.url],
    );
  });

  test("an outcome arriving after its lease ran out and another worker took over is dropped", async () => {
    const co = await company();
    const e = await endpoint(co.people.boss, ["leave.requested"]);
    await submit(co);
    await dispatchOutboxBatch(ctx);
    const firstClaim = first(await claimDueDeliveries(t.db, { now: T0, leaseUntil: new Date(T0.getTime() + 120_000), limit: 10 }));
    assert.equal(firstClaim.attempts, 1);
    assert.equal((await claimDueDeliveries(t.db, { now: T0, leaseUntil: new Date(T0.getTime() + 120_000), limit: 10 })).length, 0, "leased");
    const later = new Date(T0.getTime() + 121_000);
    const second = first(await claimDueDeliveries(t.db, { now: later, leaseUntil: new Date(later.getTime() + 120_000), limit: 10 }));
    assert.equal(second.attempts, 2);
    const delivered = { status: "delivered" as const, at: later, statusCode: 200, latencyMs: 5, excerpt: null };
    assert.equal(await recordDeliveryOutcome(t.db, firstClaim, delivered), false, "the stale claim loses");
    assert.equal(await recordDeliveryOutcome(t.db, second, delivered), true);
    const row = first(await t.db.select().from(schema.webhookDeliveries).where(and(eq(schema.webhookDeliveries.endpointId, e.id))));
    assert.equal(row.status, "delivered");
  });

  test("shutdown mid-batch: the attempt in flight finishes, the rest is released unattempted and due at once", async () => {
    const co = await company();
    const e = await endpoint(co.people.boss, ["leave.requested"]);
    for (const day of ["2026-11-09", "2026-11-10", "2026-11-11"]) await submit(co, day);
    await dispatchOutboxBatch(ctx);
    const stop = new AbortController();
    const { fetch, calls } = recorder(async (_call, signal) => {
      stop.abort(); // SIGTERM arrives while the first attempt is in flight
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(signal.aborted, false, "the in-flight request is not cut short");
      return new Response(null, { status: 204 });
    });
    const run = await deliverDueWebhooks(ctx, { fetch, concurrency: 1, signal: stop.signal });
    assert.deepEqual(run, { attempted: 1, delivered: 1, retried: 0, failed: 0 });
    assert.equal(calls.length, 1, "nothing started after the signal");
    const rows = await deliveriesOf(e.id);
    assert.deepEqual(rows.map((r) => r.status).sort(), ["delivered", "pending", "pending"]);
    for (const r of rows.filter((x) => x.status === "pending")) {
      assert.equal(r.attempts, 0, "a released claim spends no attempt");
      assert.equal(r.nextAttemptAt.getTime(), T0.getTime(), "due at once, not after the lease");
    }
    assert.equal((await deliverDueWebhooks(ctx, { fetch: recorder().fetch, signal: stop.signal })).attempted, 0, "a stopped worker claims nothing");
    const next = await deliverDueWebhooks(ctx, { fetch: recorder().fetch });
    assert.equal(next.delivered, 2, "the next worker takes them straight away");
    assert.ok((await deliveriesOf(e.id)).every((r) => r.status === "delivered" && r.attempts === 1));
  });

  test("worker log lines never carry the URL, secret, signature or body", async () => {
    const co = await company();
    const e = await endpoint(co.people.boss, ["leave.requested"], `${host()}?token=sekret-token`);
    await submit(co);
    await dispatchOutboxBatch(ctx);
    const { fetch, calls } = recorder(() => new Response("nope", { status: 500 }));
    const lines: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string) => (lines.push(String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string) => (lines.push(String(c)), true)) as typeof process.stderr.write;
    try {
      await deliverDueWebhooks(ctx, { fetch });
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    const logged = lines.join("");
    assert.match(logged, /webhook_delivery_retry_scheduled/);
    for (const secretish of ["sekret-token", e.secret, present(first(calls).headers["OOOhm-Signature"]).slice(3), first(calls).body]) {
      assert.ok(!logged.includes(secretish), "nothing secret in the log");
    }
  });
});

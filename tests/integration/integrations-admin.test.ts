import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { diffAuditSnapshots } from "@/domain/audit";
import { MAX_WEBHOOK_ENDPOINTS } from "@/domain/integrations";
import { hashApiKey } from "@/lib/integration-crypto";
import { authenticateApiKey, createApiKey, listApiKeys, revokeApiKey } from "@/server/services/api-keys";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
  rotateWebhookSecret,
  sendWebhookPing,
  setWebhookEndpointEnabled,
  updateWebhookEndpoint,
} from "@/server/services/webhooks";
import { rejectsWith } from "./assertions";
import { companyAudit, companyEvents, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const URL_WITH_TOKEN = "https://hooks.example.com/catch/123/s3cr3t-path-token?sig=abc";

describe("webhook endpoints and API keys (admin)", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const company = () => seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
  const input = { url: URL_WITH_TOKEN, description: "Payroll sync", eventTypes: ["leave.approved", "leave.requested"] };

  test("create: the secret is returned once, stored only sealed, and never in the audit row or event; only the URL's origin is", async () => {
    const co = await company();
    const ctx = createTestContext(t.db);
    const { endpoint, secret } = await createWebhookEndpoint(ctx, co.people.boss, input);
    assert.match(secret, /^whsec_/);
    assert.deepEqual(endpoint.eventTypes, ["leave.requested", "leave.approved"], "catalogue order");

    const [row] = await t.db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpoint.id));
    assert.ok(!row.secretCiphertext.includes(secret));
    assert.equal(ctx.secrets.open(row.secretCiphertext, endpoint.id), secret);

    const [audit] = await companyAudit(t.db, co.companyId, "webhook_endpoint.");
    const [event] = await companyEvents(t.db, co.companyId, "webhook_endpoint.");
    assert.equal(audit.action, "webhook_endpoint.created");
    assert.equal(audit.actorId, co.people.boss.id);
    assert.deepEqual(event.payload, {
      endpointId: endpoint.id,
      urlOrigin: "https://hooks.example.com",
      description: "Payroll sync",
      eventTypes: ["leave.requested", "leave.approved"],
      enabled: true,
      actorId: co.people.boss.id,
    });
    for (const json of [JSON.stringify(audit), JSON.stringify(event)]) {
      assert.ok(!json.includes(secret), "no secret");
      assert.ok(!json.includes("s3cr3t-path-token"), "no URL path");
      assert.ok(!json.includes(row.secretCiphertext), "no ciphertext");
    }
  });

  test("URLs are checked against the target policy: https and public only, unless development flags allow", async () => {
    const co = await company();
    const strict = createTestContext(t.db);
    await rejectsWith(createWebhookEndpoint(strict, co.people.boss, { ...input, url: "http://hooks.example.com/x" }), "insecure_url");
    await rejectsWith(createWebhookEndpoint(strict, co.people.boss, { ...input, url: "https://127.0.0.1/x" }), "blocked_address");
    await rejectsWith(createWebhookEndpoint(strict, co.people.boss, { ...input, url: "https://localhost/x" }), "blocked_address");
    await rejectsWith(createWebhookEndpoint(strict, co.people.boss, { ...input, eventTypes: [] }), "invalid_input");
    await rejectsWith(createWebhookEndpoint(strict, co.people.boss, { ...input, eventTypes: ["leave.exploded"] }), "invalid_input");
    const dev = createTestContext(t.db, { webhookTargets: { allowInsecure: true, allowPrivate: true } });
    const { endpoint } = await createWebhookEndpoint(dev, co.people.boss, { ...input, url: "http://localhost:4000/hook" });
    assert.equal(endpoint.url, "http://localhost:4000/hook");
    assert.equal((await companyEvents(t.db, co.companyId, "webhook_endpoint.created")).length, 1, "refused creates record nothing");
  });

  test("non-admins are refused, and another company's endpoint reads as not found", async () => {
    const co = await company();
    const other = await company();
    const ctx = createTestContext(t.db);
    await rejectsWith(createWebhookEndpoint(ctx, co.people.ana, input), "forbidden");
    await rejectsWith(listWebhookEndpoints(ctx, co.people.ana), "forbidden");
    const { endpoint } = await createWebhookEndpoint(ctx, other.people.boss, input);
    await rejectsWith(getWebhookEndpoint(ctx, co.people.boss, endpoint.id), "not_found");
    await rejectsWith(updateWebhookEndpoint(ctx, co.people.boss, endpoint.id, input), "not_found");
    await rejectsWith(setWebhookEndpointEnabled(ctx, co.people.boss, endpoint.id, false), "not_found");
    await rejectsWith(rotateWebhookSecret(ctx, co.people.boss, endpoint.id), "not_found");
    await rejectsWith(deleteWebhookEndpoint(ctx, co.people.boss, endpoint.id), "not_found");
    await rejectsWith(sendWebhookPing(ctx, co.people.boss, endpoint.id), "not_found");
    await rejectsWith(getWebhookEndpoint(ctx, co.people.boss, "not-a-uuid"), "not_found");
    assert.deepEqual((await listWebhookEndpoints(ctx, co.people.boss)).endpoints, []);
  });

  test("an admin demoted a moment ago is refused inside the transaction", async () => {
    const co = await company();
    const ctx = createTestContext(t.db);
    await t.db.update(schema.user).set({ role: "employee" }).where(eq(schema.user.id, co.people.boss.id));
    await rejectsWith(createWebhookEndpoint(ctx, co.people.boss, input), "forbidden");
    await rejectsWith(createApiKey(ctx, co.people.boss, { name: "x" }), "forbidden");
  });

  test("every change writes its audit row and event in pairs; a save that changes nothing records nothing", async () => {
    const co = await company();
    const ctx = createTestContext(t.db);
    const { endpoint } = await createWebhookEndpoint(ctx, co.people.boss, input);
    assert.equal(await updateWebhookEndpoint(ctx, co.people.boss, endpoint.id, input), false);
    assert.equal(await updateWebhookEndpoint(ctx, co.people.boss, endpoint.id, { ...input, description: "Renamed" }), true);
    assert.equal(await setWebhookEndpointEnabled(ctx, co.people.boss, endpoint.id, false), true);
    assert.equal(await setWebhookEndpointEnabled(ctx, co.people.boss, endpoint.id, false), false);
    await rejectsWith(sendWebhookPing(ctx, co.people.boss, endpoint.id), "conflict");
    await setWebhookEndpointEnabled(ctx, co.people.boss, endpoint.id, true);
    const { secret } = await rotateWebhookSecret(ctx, co.people.boss, endpoint.id);
    const [row] = await t.db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, endpoint.id));
    assert.equal(ctx.secrets.open(row.secretCiphertext, endpoint.id), secret);
    await sendWebhookPing(ctx, co.people.boss, endpoint.id);
    await deleteWebhookEndpoint(ctx, co.people.boss, endpoint.id);
    await rejectsWith(getWebhookEndpoint(ctx, co.people.boss, endpoint.id), "not_found");

    const expected = [
      "webhook_endpoint.created",
      "webhook_endpoint.updated",
      "webhook_endpoint.disabled",
      "webhook_endpoint.enabled",
      "webhook_endpoint.secret_rotated",
      "webhook_endpoint.pinged",
      "webhook_endpoint.deleted",
    ];
    assert.deepEqual((await companyAudit(t.db, co.companyId, "webhook_endpoint.")).map((a) => a.action), expected);
    assert.deepEqual((await companyEvents(t.db, co.companyId, "webhook_endpoint.")).map((e) => e.type), expected);
    const json = JSON.stringify(await companyEvents(t.db, co.companyId, "webhook_endpoint."));
    assert.ok(!json.includes(secret));
  });

  test("moving an endpoint to another path on the same host shows in the audit row and event, without the path", async () => {
    const co = await company();
    const ctx = createTestContext(t.db);
    const { endpoint } = await createWebhookEndpoint(ctx, co.people.boss, input);
    const moved = "https://hooks.example.com/catch/999/0ther-path-token";
    assert.equal(await updateWebhookEndpoint(ctx, co.people.boss, endpoint.id, { ...input, url: moved }), true);
    assert.equal(await updateWebhookEndpoint(ctx, co.people.boss, endpoint.id, { ...input, url: moved, description: "Renamed" }), true);

    const [urlEdit, descriptionEdit] = await companyAudit(t.db, co.companyId, "webhook_endpoint.updated");
    assert.deepEqual(diffAuditSnapshots(urlEdit.before, urlEdit.after), [{ field: "urlChanged", after: true }], "the same origin, yet a change shows");
    assert.deepEqual(
      diffAuditSnapshots(descriptionEdit.before, descriptionEdit.after),
      [{ field: "description", before: "Payroll sync", after: "Renamed" }],
      "paired: a save that keeps the URL does not claim it changed",
    );
    const events = await companyEvents(t.db, co.companyId, "webhook_endpoint.updated");
    assert.deepEqual(
      events.map((e) => [(e.payload as { urlOrigin: string }).urlOrigin, (e.payload as { urlChanged: boolean }).urlChanged]),
      [
        ["https://hooks.example.com", true],
        ["https://hooks.example.com", false],
      ],
    );
    const json = JSON.stringify([urlEdit, descriptionEdit, events]);
    for (const secretPart of ["s3cr3t-path-token", "0ther-path-token", "/catch/"]) assert.ok(!json.includes(secretPart), `no ${secretPart}`);
  });

  test(`a company may have at most ${MAX_WEBHOOK_ENDPOINTS} live endpoints; deleting one frees a place`, async () => {
    const co = await company();
    const ctx = createTestContext(t.db);
    const ids: string[] = [];
    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS; i++) ids.push((await createWebhookEndpoint(ctx, co.people.boss, input)).endpoint.id);
    await rejectsWith(createWebhookEndpoint(ctx, co.people.boss, input), "limit_reached");
    await deleteWebhookEndpoint(ctx, co.people.boss, ids[0]);
    await createWebhookEndpoint(ctx, co.people.boss, input);
  });

  test("API keys: shown once, stored as a hash, revocable, audited without the key", async () => {
    const co = await company();
    const ctx = createTestContext(t.db);
    const { key, apiKey } = await createApiKey(ctx, co.people.boss, { name: " Payroll  export " });
    assert.match(key, /^ooohm_[A-Za-z0-9_-]{43}$/);
    assert.equal(apiKey.name, "Payroll export");
    assert.deepEqual(apiKey.scopes, ["read"]);
    assert.equal(apiKey.prefix, key.slice(0, 14));

    const [row] = await t.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey.id));
    assert.equal(row.keyHash, hashApiKey(key));
    const listed = await listApiKeys(ctx, co.people.boss);
    assert.ok(!JSON.stringify(listed).includes(row.keyHash), "the list never carries the hash");
    assert.equal(listed.keys[0].createdByEmail, co.people.boss.email);

    assert.deepEqual(await authenticateApiKey(ctx, key), { keyId: apiKey.id, companyId: co.companyId, scopes: ["read"] });
    const [used] = await t.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey.id));
    assert.deepEqual(used.lastUsedAt, ctx.now());

    assert.equal(await revokeApiKey(ctx, co.people.boss, apiKey.id), true);
    assert.equal(await revokeApiKey(ctx, co.people.boss, apiKey.id), false, "revoking twice changes nothing");
    assert.equal(await authenticateApiKey(ctx, key), null);

    const audits = await companyAudit(t.db, co.companyId, "api_key.");
    const events = await companyEvents(t.db, co.companyId, "api_key.");
    assert.deepEqual(audits.map((a) => a.action), ["api_key.created", "api_key.revoked"]);
    assert.deepEqual(events.map((e) => e.type), ["api_key.created", "api_key.revoked"]);
    assert.deepEqual(events[0].payload, { apiKeyId: apiKey.id, name: "Payroll export", prefix: apiKey.prefix, scopes: ["read"], actorId: co.people.boss.id });
    for (const json of [JSON.stringify(audits), JSON.stringify(events)]) {
      assert.ok(!json.includes(key) && !json.includes(row.keyHash));
    }
  });

  test("API keys: non-admins refused; another company's key is not found; names are checked", async () => {
    const co = await company();
    const other = await company();
    const ctx = createTestContext(t.db);
    await rejectsWith(createApiKey(ctx, co.people.ana, { name: "x" }), "forbidden");
    await rejectsWith(listApiKeys(ctx, co.people.ana), "forbidden");
    await rejectsWith(createApiKey(ctx, co.people.boss, { name: "   " }), "invalid_input");
    const { apiKey } = await createApiKey(ctx, other.people.boss, { name: "theirs" });
    await rejectsWith(revokeApiKey(ctx, co.people.boss, apiKey.id), "not_found");
    assert.equal((await authenticateApiKey(ctx, "ooohm_" + "A".repeat(43))), null, "an unknown key");
  });

  test("last used is written at most once a minute per key", async () => {
    const co = await company();
    const ctx = createTestContext(t.db);
    const { key, apiKey } = await createApiKey(ctx, co.people.boss, { name: "busy" });
    const at = (iso: string) => createTestContext(t.db, { now: new Date(iso) });
    const lastUsed = async () => (await t.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey.id)))[0].lastUsedAt?.toISOString();
    await authenticateApiKey(at("2026-11-01T10:00:00Z"), key);
    await authenticateApiKey(at("2026-11-01T10:00:59Z"), key);
    assert.equal(await lastUsed(), "2026-11-01T10:00:00.000Z");
    await authenticateApiKey(at("2026-11-01T10:01:00Z"), key);
    assert.equal(await lastUsed(), "2026-11-01T10:01:00.000Z");
  });
});

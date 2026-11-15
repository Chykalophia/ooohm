import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor } from "@/shared/kernel/actor";
import {
  canManageAdapters,
  canManageApiKeys,
  canManageWebhooks,
  createApiKey,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listAdapters,
  listApiKeys,
  listWebhookEndpoints,
  redeliverWebhook,
  revokeApiKey,
  rotateWebhookSecret,
  sendWebhookPing,
  setWebhookEndpointEnabled,
  syncAdapterNow,
  updateWebhookEndpoint,
} from "@/modules/integrations";
import type { ServiceContext } from "@/server/context";
import type { ServiceResult } from "@/shared/lib/result";

const actor = (role: Actor["role"]): Actor => ({ id: "u-1", companyId: "co-1", role, canSelfApprove: false, source: { kind: "user", userId: "u-1" } });

/** A context whose every port throws: a refusal must come before any read, write or secret. */
const untouchable = new Proxy({} as ServiceContext, {
  get(_target, port) {
    throw new Error(`the policy check came after ctx.${String(port)}`);
  },
});

const ID = "00000000-0000-4000-8000-000000000001";
const endpoint = { url: "https://hooks.example.com/x", description: "", eventTypes: ["leave.approved"] };

describe("who may manage integrations", () => {
  for (const [name, can] of [
    ["webhooks", canManageWebhooks],
    ["API keys", canManageApiKeys],
    ["adapters", canManageAdapters],
  ] as const) {
    test(`${name}: admins only`, () => {
      assert.equal(can({ role: "admin" }), true);
      assert.equal(can({ role: "manager" }), false);
      assert.equal(can({ role: "employee" }), false);
    });
  }
});

describe("every integrations use case refuses a manager or employee before it touches anything", () => {
  const calls: [string, (ctx: ServiceContext, a: Actor) => Promise<ServiceResult<unknown>>][] = [
    ["listWebhookEndpoints", (ctx, a) => listWebhookEndpoints(ctx, a)],
    ["getWebhookEndpoint", (ctx, a) => getWebhookEndpoint(ctx, a, ID)],
    ["createWebhookEndpoint", (ctx, a) => createWebhookEndpoint(ctx, a, endpoint)],
    ["updateWebhookEndpoint", (ctx, a) => updateWebhookEndpoint(ctx, a, ID, endpoint)],
    ["setWebhookEndpointEnabled", (ctx, a) => setWebhookEndpointEnabled(ctx, a, ID, false)],
    ["rotateWebhookSecret", (ctx, a) => rotateWebhookSecret(ctx, a, ID)],
    ["deleteWebhookEndpoint", (ctx, a) => deleteWebhookEndpoint(ctx, a, ID)],
    ["sendWebhookPing", (ctx, a) => sendWebhookPing(ctx, a, ID)],
    ["redeliverWebhook", (ctx, a) => redeliverWebhook(ctx, a, ID, ID)],
    ["listApiKeys", (ctx, a) => listApiKeys(ctx, a)],
    ["createApiKey", (ctx, a) => createApiKey(ctx, a, { name: "Payroll" })],
    ["revokeApiKey", (ctx, a) => revokeApiKey(ctx, a, ID)],
    ["listAdapters", (ctx, a) => listAdapters(ctx, a)],
    ["syncAdapterNow", (ctx, a) => syncAdapterNow(ctx, a, "gusto")],
  ];
  for (const role of ["manager", "employee"] as const) {
    for (const [name, call] of calls) {
      test(`${name} (${role})`, async () => {
        const result = await call(untouchable, actor(role));
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.error.code, "forbidden");
      });
    }
  }
});

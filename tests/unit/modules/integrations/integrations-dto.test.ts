import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type ApiKeyDTO,
  type CreatedApiKeyDTO,
  toApiKeyDTO,
  toWebhookDeliveryDTO,
  toWebhookEndpointDTO,
  type WebhookDeliveryDTO,
  type WebhookEndpointDTO,
} from "@/modules/integrations/application/dto";

/**
 * The admin screens read these DTOs and nothing else. An API key's hash and an endpoint's
 * signing secret (sealed or not) are not fields of any of them, so neither can reach a
 * page, even when the row a repository read carries it.
 */

const AT = new Date("2026-11-02T15:04:05Z");
const HASH = "f".repeat(64);
const SEALED = "v1.sealed-secret-ciphertext";

/** Compile-time: `K` is not a key of `T`. */
type Lacks<T, K extends string> = K extends keyof T ? false : true;
const lacks: [
  Lacks<ApiKeyDTO, "keyHash">,
  Lacks<CreatedApiKeyDTO["apiKey"], "keyHash">,
  Lacks<WebhookEndpointDTO, "secretCiphertext">,
  Lacks<WebhookEndpointDTO, "secret">,
  Lacks<WebhookDeliveryDTO, "body">,
] = [true, true, true, true, true];

describe("API key DTO", () => {
  test("never carries the key's hash or the company, even when the row does", () => {
    const row = {
      id: "k-1",
      companyId: "co-1",
      name: "Payroll",
      prefix: "ooohm_Ab3dE",
      keyHash: HASH,
      scopes: ["read"],
      createdAt: AT,
      lastUsedAt: null,
      revokedAt: null,
      createdByName: "Peter Boss",
      createdByEmail: "peter@acme.test",
    };
    const dto = toApiKeyDTO(row);
    assert.deepEqual(Object.keys(dto).sort(), ["createdAt", "createdByEmail", "createdByName", "id", "lastUsedAt", "name", "prefix", "revokedAt", "scopes"]);
    assert.ok(!JSON.stringify(dto).includes(HASH));
    assert.ok(lacks.every(Boolean));
  });
});

describe("webhook DTOs", () => {
  test("an endpoint never carries its secret", () => {
    const dto = toWebhookEndpointDTO({
      id: "e-1",
      companyId: "co-1",
      url: "https://hooks.example.com/T000/secret-path",
      description: "Payroll",
      eventTypes: ["leave.approved"],
      secretCiphertext: SEALED,
      enabled: true,
      createdAt: AT,
    });
    assert.deepEqual(Object.keys(dto).sort(), ["createdAt", "description", "enabled", "eventTypes", "id", "url"]);
    assert.ok(!JSON.stringify(dto).includes(SEALED));
  });

  test("a delivery never carries its body or the page cursor", () => {
    const row = {
      id: "d-1",
      endpointId: "e-1",
      eventId: "ev-1",
      eventType: "leave.approved",
      status: "failed" as const,
      attempts: 8,
      nextAttemptAt: AT,
      lastAttemptAt: AT,
      lastStatusCode: 500,
      lastLatencyMs: 120,
      lastError: "HTTP 500",
      deliveredAt: null,
      createdAt: AT,
      body: '{"secret":"x"}',
      cursor: "2026-11-02 15:04:05+00",
    };
    const dto = toWebhookDeliveryDTO(row);
    assert.equal("body" in dto, false);
    assert.equal("cursor" in dto, false);
    assert.equal(dto.status, "failed");
  });
});

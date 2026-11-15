/**
 * The event contract (docs/api.md#events): every event type OOOhm sends has a schema,
 * every recorded sample in events.json matches it, and the payloads the code builds
 * match it too. A field added in code without the contract fails here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { buildEnvelope, type EventEnvelope } from "@/domain/event-envelope";
import { byApiKey, bySystem, byUser, through } from "@/domain/change-source";
import { eventAttribution, INTEGRATION_EVENT_TYPES, leaveEventPayload } from "@/domain/events";
import { contractProblems, EVENT_PAYLOAD_SCHEMAS, envelopeSchema, eventActorSchema } from "@/modules/integrations/application/contracts";
import { apiKeyEventPayload } from "@/modules/integrations/application/api-key-changes";
import { endpointEventPayload, pingEnvelope } from "@/modules/integrations/application/webhook-changes";
import { PING_EVENT_TYPE, WEBHOOK_EVENT_TYPES } from "@/modules/integrations/domain/integrations";

const samples = JSON.parse(readFileSync(new URL("./events.json", import.meta.url), "utf8")) as EventEnvelope[];
const docs = readFileSync(new URL("../../docs/api.md", import.meta.url), "utf8");
const eventsSection = docs.slice(docs.indexOf("## Events"), docs.indexOf("## Webhooks"));

const ADMIN = "0b8f3c2e-5a61-4d0e-9f3b-2c7d1e4a6b90";
const COMPANY = "e24b2035-464a-41c7-839d-095328689365";
const at = new Date("2026-11-02T15:04:05.123Z");

/** A built payload as the outbox holds it: `recordChange` adds the attribution. */
const envelopeOf = (type: string, payload: object, source = byUser(ADMIN)) =>
  buildEnvelope({ id: "6e703ccd-f3ad-4960-b62c-f80dfa6b2b68", type, companyId: COMPANY, createdAt: at, payload: { ...payload, ...eventAttribution(source) } });

const endpointRow = {
  id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  companyId: COMPANY,
  url: "https://hooks.example.com/services/T000/B000/secret-token",
  description: "Payroll",
  eventTypes: ["leave.approved"],
  secretCiphertext: "sealed",
  enabled: true,
  createdAt: at,
};

describe("the event catalogue", () => {
  test("every event an endpoint can subscribe to, and ping, has a payload contract", () => {
    const missing = [...WEBHOOK_EVENT_TYPES, PING_EVENT_TYPE].filter((t) => !EVENT_PAYLOAD_SCHEMAS[t]);
    assert.deepEqual(missing, []);
  });

  test("every contract names an event the code sends (no stale entries)", () => {
    const known = new Set([...WEBHOOK_EVENT_TYPES, PING_EVENT_TYPE]);
    assert.deepEqual(Object.keys(EVENT_PAYLOAD_SCHEMAS).filter((t) => !known.has(t)), []);
  });

  test("docs/api.md names every event type, in full or as `.suffix` of its family", () => {
    const undocumented = Object.keys(EVENT_PAYLOAD_SCHEMAS).filter((t) => {
      const [family, ...rest] = t.split(".");
      return !eventsSection.includes(`\`${t}\``) && !(eventsSection.includes(`\`${family}.`) && eventsSection.includes(`\`.${rest.join(".")}\``));
    });
    assert.deepEqual(undocumented, []);
  });
});

describe("recorded samples (tests/contracts/events.json)", () => {
  test("there is one sample for every event type", () => {
    assert.deepEqual(samples.map((s) => s.type).sort(), Object.keys(EVENT_PAYLOAD_SCHEMAS).sort());
  });

  for (const sample of samples) {
    test(`${sample.type} matches its contract`, () => assert.deepEqual(contractProblems(sample), []));
  }

  test("the envelope is built field for field from the outbox row", () => {
    for (const sample of samples) {
      const built = buildEnvelope({ id: sample.id, type: sample.type, companyId: sample.companyId, createdAt: new Date(sample.createdAt), payload: sample.data });
      assert.deepEqual(built, sample);
    }
  });

  test("an extra field in a payload, or a wrong envelope version, breaks the contract", () => {
    const approved = samples.find((s) => s.type === "leave.approved")!;
    assert.notDeepEqual(contractProblems({ ...approved, data: { ...(approved.data as object), note: "Dentist" } }), []);
    assert.equal(envelopeSchema.safeParse({ ...approved, version: 2 }).success, false);
    assert.deepEqual(contractProblems({ ...approved, type: "leave.unknown" }), ['type: no contract for "leave.unknown"']);
  });
});

describe("what the code builds", () => {
  test("every kind of change source publishes an actor the contract accepts", () => {
    const sources = [
      byUser(ADMIN),
      through(byUser(ADMIN), "timeoff_import"),
      byApiKey({ userId: ADMIN, apiKeyId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d" }),
      bySystem("year_rollover"),
      bySystem("scheduled_scrub", ADMIN),
    ];
    for (const source of sources) assert.equal(eventActorSchema.safeParse(eventAttribution(source).actor).success, true, JSON.stringify(source));
  });

  test("leave events", () => {
    const request = { id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", userId: ADMIN, leaveTypeId: ADMIN, startDate: "2026-12-21", endDate: "2026-12-21", dayPortion: "am", days: 0.5, status: "approved" } as const;
    const payload = leaveEventPayload(request, byUser(ADMIN));
    assert.deepEqual(contractProblems(buildEnvelope({ id: request.id, type: "leave.approved", companyId: COMPANY, createdAt: at, payload })), []);
  });

  test("webhook endpoint events carry the URL's origin, never its path", () => {
    for (const type of Object.values(INTEGRATION_EVENT_TYPES).filter((t) => t.startsWith("webhook_endpoint."))) {
      const after = type === INTEGRATION_EVENT_TYPES.webhookEndpointUpdated ? { ...endpointRow, url: "https://hooks.example.com/other" } : endpointRow;
      const envelope = envelopeOf(type, endpointEventPayload(type, endpointRow, after));
      assert.deepEqual(contractProblems(envelope), [], type);
      assert.doesNotMatch(JSON.stringify(envelope), /secret-token|sealed|\/other/);
    }
  });

  test("API key events never hold the key or its hash", () => {
    const row = { id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", companyId: COMPANY, name: "Payroll", prefix: "ooohm_Ab3dE", keyHash: "f".repeat(64), scopes: ["read"], createdAt: at, lastUsedAt: null, revokedAt: null };
    for (const type of [INTEGRATION_EVENT_TYPES.apiKeyCreated, INTEGRATION_EVENT_TYPES.apiKeyRevoked]) {
      const envelope = envelopeOf(type, apiKeyEventPayload(row));
      assert.deepEqual(contractProblems(envelope), [], type);
      assert.doesNotMatch(JSON.stringify(envelope), /f{64}/);
    }
  });

  test("ping", () => {
    const envelope = pingEnvelope({ id: "00000000-0000-4000-8000-000000000001", endpoint: endpointRow, now: at });
    assert.deepEqual(contractProblems(envelope), []);
    assert.equal(envelope.type, PING_EVENT_TYPE);
  });
});

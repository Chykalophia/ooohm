import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type AuditRowView, toAuditLogEntryDTO } from "@/modules/audit/application/dto";

/**
 * The audit page reads an `AuditLogEntryDTO` per row and nothing else. These pin its
 * fields: what the row's joins bring (emails, API key ids, entity ids, the cursor) is
 * turned into labels or left behind.
 */

const AT = new Date("2026-03-10T09:30:00Z");

/** A row as the repository reads it, with the columns the page never shows. */
function row(over: Partial<AuditRowView> = {}): AuditRowView & Record<string, unknown> {
  return {
    id: "a-1",
    action: "leave_request.approved",
    entityType: "leave_request",
    entityId: "r-1",
    cursor: "2026-03-10 09:30:00.123456+00",
    before: { status: "submitted" },
    after: { status: "approved" },
    createdAt: AT,
    actorKind: "user",
    actorId: "boss",
    actorName: "Peter Boss",
    actorEmail: "peter@acme.test",
    apiKeyId: null,
    apiKeyName: null,
    apiKeyPrefix: null,
    actorVia: null,
    actorProcess: null,
    actorRequestedBy: null,
    requesterName: null,
    requesterEmail: null,
    subjectUserId: "ana",
    subjectName: "Ana Ruiz",
    subjectEmail: "ana@acme.test",
    ...over,
  };
}

const names = {
  snapshot: { person: () => undefined, department: () => undefined, level: () => undefined, leaveType: () => undefined, instant: (iso: string) => iso },
  adapter: (id: string) => (id === "gusto" ? "Gusto" : undefined),
};

const FIELDS = ["action", "actorId", "actorKind", "actorLabel", "at", "changes", "id", "label", "subjectName", "subjectUserId"];

describe("toAuditLogEntryDTO", () => {
  test("returns exactly the fields the page shows", () => {
    const dto = toAuditLogEntryDTO(row(), names);
    assert.deepEqual(Object.keys(dto).sort(), FIELDS);
    assert.equal(dto.id, "a-1");
    assert.equal(dto.at, AT);
    assert.equal(dto.action, "leave_request.approved");
    assert.equal(dto.label, "Leave approved");
    assert.equal(dto.actorLabel, "Peter Boss");
    assert.equal(dto.actorKind, "user");
    assert.equal(dto.actorId, "boss");
    assert.equal(dto.subjectUserId, "ana");
    assert.equal(dto.subjectName, "Ana Ruiz");
    assert.ok(dto.changes.length > 0 && dto.changes.every((line) => typeof line === "string"));
  });

  test("never carries an email address", () => {
    assert.doesNotMatch(JSON.stringify(toAuditLogEntryDTO(row(), names)), /@acme\.test/);
  });

  test("a system run is labelled as the system, with no person", () => {
    const dto = toAuditLogEntryDTO(row({ actorKind: "system", actorId: null, actorName: null, actorEmail: null, actorProcess: "rollover", subjectUserId: null }), names);
    assert.equal(dto.actorKind, "system");
    assert.equal(dto.actorId, null);
    assert.match(dto.actorLabel, /^System: /);
    assert.equal(dto.subjectName, null);
  });

  test("an API key's change names the key, never its id", () => {
    const dto = toAuditLogEntryDTO(row({ actorKind: "api_key", apiKeyId: "key-1", apiKeyName: "Zapier", apiKeyPrefix: "ooohm_ab" }), names);
    assert.equal(dto.actorKind, "api_key");
    assert.match(dto.actorLabel, /Zapier/);
    assert.doesNotMatch(dto.actorLabel, /key-1/);
  });
});

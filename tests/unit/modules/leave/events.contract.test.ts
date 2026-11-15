import assert from "node:assert/strict";
import { test } from "node:test";
import { recordLeaveChangeIn, recordReassignmentIn, recordRecountIn } from "@/modules/leave/application/leave-changes";
import { LEAVE_EVENT_NAMES } from "@/modules/leave/domain/events";
import type { LeaveRequest } from "@/modules/leave/domain/leave-request";
import { ANA, BOSS, COMPANY, MO, RecordingAudit, RecordingOutbox, recordingChangeLog, VACATION } from "./fakes/ports";

// Every `leave.*` payload is a public contract (webhooks subscribe to it): these tests pin
// each event's name and every field it publishes. Add a field here when one is added;
// never remove or retype one.

const request: LeaveRequest = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: COMPANY,
  userId: ANA,
  leaveTypeId: VACATION,
  startDate: "2026-11-09",
  endDate: "2026-11-10",
  dayPortion: "full",
  days: 2,
  note: "Private note",
  status: "pending",
  approverId: MO,
  decidedAt: null,
  decisionNote: null,
  createdAt: new Date("2026-11-02T10:00:00Z"),
  updatedAt: new Date("2026-11-02T10:00:00Z"),
};

const leaveFields = (status: LeaveRequest["status"], days = 2) => ({
  requestId: request.id,
  userId: ANA,
  leaveTypeId: VACATION,
  startDate: "2026-11-09",
  endDate: "2026-11-10",
  dayPortion: "full",
  days,
  status,
});

function recorder() {
  const audit = new RecordingAudit();
  const outbox = new RecordingOutbox();
  return { audit, outbox, changes: recordingChangeLog(audit, outbox) };
}

test("the aggregate's events map to leave.requested, leave.approved and leave.cancelled", () => {
  assert.deepEqual(LEAVE_EVENT_NAMES, { LeaveRequested: "requested", LeaveApproved: "approved", LeaveCancelled: "cancelled" });
});

for (const [event, status] of [
  ["requested", "pending"],
  ["approved", "approved"],
  ["rejected", "rejected"],
  ["cancelled", "cancelled"],
] as const) {
  test(`leave.${event} publishes the leave fields and who acted, never the note`, async () => {
    const { outbox, audit, changes } = recorder();
    const after = { ...request, status };
    await recordLeaveChangeIn(changes, { event, before: event === "requested" ? null : request, after, source: { kind: "user", userId: MO } });
    assert.deepEqual(outbox.events, [
      { companyId: COMPANY, type: `leave.${event}`, payload: { ...leaveFields(status), actorId: MO, actor: { type: "user", id: MO } } },
    ]);
    assert.equal(audit.entries[0].action, `leave_request.${event}`);
    assert.equal(audit.entries[0].entityId, request.id);
  });
}

test("leave.reassigned adds who it moved from and to", async () => {
  const { outbox, changes } = recorder();
  await recordReassignmentIn(changes, { before: request, after: { ...request, approverId: BOSS }, source: { kind: "user", userId: BOSS } });
  assert.deepEqual(outbox.events, [
    {
      companyId: COMPANY,
      type: "leave.reassigned",
      payload: { ...leaveFields("pending"), actorId: BOSS, actor: { type: "user", id: BOSS }, previousApproverId: MO, approverId: BOSS },
    },
  ]);
});

test("leave.recounted adds the previous count, and names the calendar change it came through", async () => {
  const { outbox, changes } = recorder();
  await recordRecountIn(changes, { before: request, after: { ...request, days: 1 }, source: { kind: "user", userId: BOSS, via: "holiday_change" } });
  assert.deepEqual(outbox.events, [
    {
      companyId: COMPANY,
      type: "leave.recounted",
      payload: { ...leaveFields("pending", 1), actorId: BOSS, actor: { type: "user", id: BOSS, via: "holiday_change" }, previousDays: 2 },
    },
  ]);
});

test("an API key's change publishes the key as well as its person", async () => {
  const { outbox, changes } = recorder();
  await recordLeaveChangeIn(changes, { event: "requested", before: null, after: request, source: { kind: "api_key", userId: ANA, apiKeyId: "key-1" } });
  assert.deepEqual(outbox.events[0].payload, { ...leaveFields("pending"), actorId: ANA, actor: { type: "api_key", id: ANA, apiKeyId: "key-1" } });
});

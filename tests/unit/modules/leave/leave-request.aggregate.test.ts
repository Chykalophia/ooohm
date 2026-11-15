import assert from "node:assert/strict";
import { test } from "node:test";
import { unwrap } from "@/shared/lib/result";
import type { DayCount } from "@/modules/leave/domain/day-count";
import { approveLeave, cancelLeave, type LeaveDraftFacts, type LeaveRequest, removeLeave, submitLeave } from "@/modules/leave/domain/leave-request";

const NOW = new Date("2026-11-02T10:00:00Z");
const draft = (over: Partial<LeaveDraftFacts> = {}): LeaveDraftFacts => ({
  id: "r1",
  companyId: "c1",
  userId: "ana",
  leaveTypeId: "vac",
  range: { startDate: "2026-11-09", endDate: "2026-11-10", dayPortion: "full" },
  days: 2 as DayCount,
  note: null,
  approverId: "mo",
  ...over,
});
const submit = (over: Partial<Parameters<typeof submitLeave>[0]> = {}) => submitLeave({ draft: draft(), active: [], autoApprove: false, now: NOW, ...over });
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error?.code);
const approved = (endDate: string): LeaveRequest => ({ ...unwrap(submit({ autoApprove: true })).approved!, startDate: endDate, endDate });

test("submit leaves a request pending and records LeaveRequested", () => {
  const s = unwrap(submit());
  assert.equal(s.requested.status, "pending");
  assert.equal(s.requested.decidedAt, null);
  assert.equal(s.approved, null);
  assert.deepEqual(
    s.events.map((e) => e.type),
    ["LeaveRequested"],
  );
  assert.equal(s.requested.days, 2);
  assert.equal(s.requested.approverId, "mo");
});

test("a self-approved submit is approved at once and records LeaveRequested, then LeaveApproved", () => {
  const s = unwrap(submit({ autoApprove: true, draft: draft({ approverId: "ana" }) }));
  assert.equal(s.requested.status, "pending");
  assert.equal(s.approved?.status, "approved");
  assert.equal(s.approved?.decidedAt, NOW);
  assert.deepEqual(
    s.events.map((e) => e.type),
    ["LeaveRequested", "LeaveApproved"],
  );
});

test("a submit overlapping an active request is refused; complementary half days are not", () => {
  const active = [{ startDate: "2026-11-10", endDate: "2026-11-12", dayPortion: "full" as const }];
  assert.equal(code(submit({ active })), "overlapping_request");
  assert.equal(code(submit({ active: [{ startDate: "2026-11-11", endDate: "2026-11-11", dayPortion: "full" }] })), "ok");
  const am = draft({ range: { startDate: "2026-11-09", endDate: "2026-11-09", dayPortion: "am" } });
  assert.equal(code(submit({ draft: am, active: [{ startDate: "2026-11-09", endDate: "2026-11-09", dayPortion: "pm" }] })), "ok");
  assert.equal(code(submit({ draft: am, active: [{ startDate: "2026-11-09", endDate: "2026-11-09", dayPortion: "am" }] })), "overlapping_request");
});

test("cancel works from pending and approved, and records LeaveCancelled", () => {
  const pending = unwrap(submit()).requested;
  const fromPending = unwrap(cancelLeave(pending, "2026-11-02"));
  assert.equal(fromPending.request.status, "cancelled");
  assert.equal(fromPending.event.type, "LeaveCancelled");
  assert.equal(unwrap(cancelLeave(approved("2026-11-10"), "2026-11-02")).request.status, "cancelled");
});

test("cancel of approved leave of a closed year is past_year_closed; of leave that is over, leave_taken", () => {
  assert.equal(code(cancelLeave(approved("2025-12-30"), "2026-01-05")), "past_year_closed");
  assert.equal(code(cancelLeave(approved("2026-10-30"), "2026-11-02")), "leave_taken");
  assert.equal(code(cancelLeave(approved("2026-11-02"), "2026-11-02")), "ok", "today's leave is not over yet");
});

test("illegal transitions are invalid_transition", () => {
  const cancelled = unwrap(cancelLeave(unwrap(submit()).requested, "2026-11-02")).request;
  assert.equal(code(cancelLeave(cancelled, "2026-11-02")), "invalid_transition");
  assert.equal(code(approveLeave(cancelled, NOW)), "invalid_transition");
  assert.equal(code(approveLeave(approved("2026-11-10"), NOW)), "invalid_transition");
  assert.equal(code(removeLeave(unwrap(submit()).requested, "2026-11-02", "typo")), "invalid_transition");
});

test("remove corrects approved leave of the open year with a reason, past leave included", () => {
  const removed = unwrap(removeLeave(approved("2026-10-30"), "2026-11-02", "Entered twice"));
  assert.equal(removed.request.status, "cancelled");
  assert.equal(removed.request.decisionNote, "Entered twice");
  assert.equal(code(removeLeave(approved("2025-12-30"), "2026-01-05", "late")), "past_year_closed");
});

test("the aggregate changes nothing in place", () => {
  const pending = unwrap(submit()).requested;
  const frozen = structuredClone(pending);
  unwrap(cancelLeave(pending, "2026-11-02"));
  unwrap(approveLeave(pending, NOW));
  assert.deepEqual(pending, frozen);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { byUser } from "@/domain/change-source";
import type { Actor } from "@/domain/actor";
import { isDomainError } from "@/domain/errors";
import { canCorrectLeaveFor } from "@/domain/leave-permissions";
import { assertCancellableOn, assertRemovableOn, canCancelOn, canRemoveOn, isLeaveOver } from "@/domain/request-status";

const approved = (endDate: string) => ({ status: "approved" as const, endDate });
const TODAY = "2026-11-06";

test("approved leave is over once its last day has passed; today's leave isn't", () => {
  assert.equal(isLeaveOver(approved("2026-11-05"), TODAY), true);
  assert.equal(isLeaveOver(approved("2026-11-06"), TODAY), false, "its last day is today");
  assert.equal(isLeaveOver(approved("2026-12-01"), TODAY), false);
  assert.equal(isLeaveOver({ status: "pending", endDate: "2026-11-05" }, TODAY), false, "never granted, so never taken");
});

test("the requester can't cancel approved time off that's over, but can still withdraw a pending request", () => {
  assert.equal(canCancelOn(approved("2026-11-05"), TODAY), false);
  assert.equal(canCancelOn(approved("2026-11-06"), TODAY), true, "still on it today");
  assert.equal(canCancelOn({ status: "pending", endDate: "2026-10-01" }, TODAY), true);
  assert.throws(() => assertCancellableOn(approved("2026-10-01"), TODAY), (e) => isDomainError(e, "leave_taken"));
  // A closed year keeps its own code: the fix there is a balance adjustment.
  assert.throws(() => assertCancellableOn(approved("2025-10-01"), TODAY), (e) => isDomainError(e, "past_year_closed"));
});

test("a manager or admin can remove approved leave of the open year, past or not; never a closed year's", () => {
  assert.equal(canRemoveOn(approved("2026-02-03"), TODAY), true);
  assert.equal(canRemoveOn(approved("2026-12-01"), TODAY), true);
  assert.equal(canRemoveOn(approved("2025-12-31"), TODAY), false);
  for (const status of ["pending", "rejected", "cancelled"] as const) {
    assert.equal(canRemoveOn({ status, endDate: "2026-02-03" }, TODAY), false, status);
  }
  assert.throws(() => assertRemovableOn(approved("2025-06-01"), TODAY), (e) => isDomainError(e, "past_year_closed"));
  assert.throws(() => assertRemovableOn({ status: "pending", endDate: "2026-02-03" }, TODAY), (e) => isDomainError(e, "invalid_transition"));
  assert.doesNotThrow(() => assertRemovableOn(approved("2026-02-03"), TODAY));
});

test("who may correct someone's time off: their direct manager or an admin, never themself", () => {
  const actor = (id: string, role: Actor["role"], companyId = "c1"): Actor => ({ id, companyId, role, canSelfApprove: false, source: byUser(id) });
  const ana = { id: "ana", companyId: "c1", managerId: "mgr" };
  assert.equal(canCorrectLeaveFor(actor("mgr", "manager"), ana), true);
  assert.equal(canCorrectLeaveFor(actor("boss", "admin"), ana), true);
  assert.equal(canCorrectLeaveFor(actor("other", "manager"), ana), false);
  assert.equal(canCorrectLeaveFor(actor("ana", "admin"), ana), false);
  assert.equal(canCorrectLeaveFor(actor("boss", "admin", "c2"), ana), false);
});

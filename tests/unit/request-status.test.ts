import assert from "node:assert/strict";
import { test } from "node:test";
import { isDomainError } from "@/domain/errors";
import { LEAVE_STATUSES, type LeaveStatus } from "@/domain/leave-request";
import { assertTransition, canTransition, isCancellable } from "@/domain/request-status";

const ALLOWED = new Set(["pending>approved", "pending>rejected", "pending>cancelled", "approved>cancelled"]);

test("exactly the documented transitions are allowed", () => {
  for (const from of LEAVE_STATUSES) {
    for (const to of LEAVE_STATUSES) {
      assert.equal(canTransition(from, to), ALLOWED.has(`${from}>${to}`), `${from} -> ${to}`);
    }
  }
});

test("a disallowed transition throws invalid_transition; an allowed one does not", () => {
  assert.throws(() => assertTransition("approved", "rejected"), (e) => isDomainError(e, "invalid_transition"));
  assert.throws(() => assertTransition("rejected", "approved"), (e) => isDomainError(e, "invalid_transition"));
  assert.throws(() => assertTransition("cancelled", "cancelled"), (e) => isDomainError(e, "invalid_transition"));
  assert.doesNotThrow(() => assertTransition("approved", "cancelled"));
});

test("pending and approved requests can be cancelled; decided-against and cancelled cannot", () => {
  const cancellable: Record<LeaveStatus, boolean> = { pending: true, approved: true, rejected: false, cancelled: false };
  for (const status of LEAVE_STATUSES) assert.equal(isCancellable(status), cancellable[status], status);
});

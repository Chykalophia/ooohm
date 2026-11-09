import assert from "node:assert/strict";
import { test } from "node:test";
import { isDomainError } from "@/domain/errors";
import { LEAVE_STATUSES, type LeaveStatus } from "@/domain/leave-request";
import { assertCancellableOn, assertTransition, canCancelOn, canTransition, isCancellable, isClosedYearLeave } from "@/domain/request-status";

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

test("approved leave that ended before this year is closed; the year turns on the company's today", () => {
  const approved = (endDate: string) => ({ status: "approved" as const, endDate });
  assert.equal(isClosedYearLeave(approved("2025-12-31"), "2026-01-01"), true, "ended on the last day of last year");
  assert.equal(isClosedYearLeave(approved("2025-06-10"), "2026-11-01"), true);
  assert.equal(isClosedYearLeave(approved("2026-01-01"), "2026-01-01"), false, "ends on the first day of this year");
  assert.equal(isClosedYearLeave(approved("2025-12-31"), "2025-12-31"), false, "still last year's today");
  assert.equal(isClosedYearLeave(approved("2027-01-04"), "2026-11-01"), false, "future leave");
});

test("a request spanning New Year counts by its end date: cancellable while any of it is in the open year", () => {
  // Mon Dec 29 2025 to Fri Jan 2 2026, cancelled on Jan 1 2026: allowed, since part is in 2026 and not over.
  assert.equal(canCancelOn({ status: "approved", endDate: "2026-01-02" }, "2026-01-01"), true);
  assert.equal(isClosedYearLeave({ status: "approved", endDate: "2026-01-02" }, "2026-03-01"), false, "not closed, only over");
  // The same request a year later: all of it is in closed years.
  assert.equal(canCancelOn({ status: "approved", endDate: "2026-01-02" }, "2027-01-01"), false);
});

test("only approved leave is closed: a pending request from a past year can still be withdrawn", () => {
  assert.equal(isClosedYearLeave({ status: "pending", endDate: "2025-03-01" }, "2026-11-01"), false);
  assert.equal(canCancelOn({ status: "pending", endDate: "2025-03-01" }, "2026-11-01"), true);
  for (const status of ["rejected", "cancelled"] as const) {
    assert.equal(canCancelOn({ status, endDate: "2026-12-01" }, "2026-11-01"), false, status);
  }
});

test("cancelling closed-year leave throws past_year_closed; a finished request still throws invalid_transition", () => {
  assert.throws(() => assertCancellableOn({ status: "approved", endDate: "2025-05-02" }, "2026-11-01"), (e) => isDomainError(e, "past_year_closed"));
  assert.throws(() => assertCancellableOn({ status: "cancelled", endDate: "2025-05-02" }, "2026-11-01"), (e) => isDomainError(e, "invalid_transition"));
  assert.doesNotThrow(() => assertCancellableOn({ status: "approved", endDate: "2026-12-02" }, "2026-11-01"));
});

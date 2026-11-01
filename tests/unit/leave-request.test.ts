import assert from "node:assert/strict";
import { test } from "node:test";
import { isDomainError } from "@/domain/errors";
import { type LeaveRange, normalizeNote, NOTE_MAX_LENGTH, rangesOverlap } from "@/domain/leave-request";

const r = (startDate: string, endDate: string, dayPortion: LeaveRange["dayPortion"] = "full"): LeaveRange => ({
  startDate,
  endDate,
  dayPortion,
});

test("ranges that share any date overlap", () => {
  assert.equal(rangesOverlap(r("2026-11-02", "2026-11-06"), r("2026-11-06", "2026-11-10")), true);
  assert.equal(rangesOverlap(r("2026-11-02", "2026-11-10"), r("2026-11-04", "2026-11-05")), true);
  assert.equal(rangesOverlap(r("2026-11-04", "2026-11-04"), r("2026-11-02", "2026-11-10")), true);
});

test("adjacent ranges do not overlap", () => {
  assert.equal(rangesOverlap(r("2026-11-02", "2026-11-05"), r("2026-11-06", "2026-11-06")), false);
  assert.equal(rangesOverlap(r("2026-11-06", "2026-11-06"), r("2026-11-02", "2026-11-05")), false);
});

test("a morning and an afternoon on the same date fit together; anything else on that date clashes", () => {
  const d = "2026-11-02";
  assert.equal(rangesOverlap(r(d, d, "am"), r(d, d, "pm")), false);
  assert.equal(rangesOverlap(r(d, d, "pm"), r(d, d, "am")), false);
  assert.equal(rangesOverlap(r(d, d, "am"), r(d, d, "am")), true);
  assert.equal(rangesOverlap(r(d, d, "pm"), r(d, d, "pm")), true);
  assert.equal(rangesOverlap(r(d, d, "full"), r(d, d, "am")), true);
  assert.equal(rangesOverlap(r(d, d, "am"), r("2026-11-01", "2026-11-03")), true);
  // Halves on different dates never meet.
  assert.equal(rangesOverlap(r(d, d, "am"), r("2026-11-03", "2026-11-03", "pm")), false);
});

test("notes are trimmed, blank becomes null, and the limit is inclusive", () => {
  assert.equal(normalizeNote("  dentist  "), "dentist");
  assert.equal(normalizeNote("   "), null);
  assert.equal(normalizeNote(undefined), null);
  assert.equal(normalizeNote(null), null);
  assert.equal(normalizeNote("x".repeat(NOTE_MAX_LENGTH)), "x".repeat(NOTE_MAX_LENGTH));
  assert.throws(() => normalizeNote("x".repeat(NOTE_MAX_LENGTH + 1)), (e) => isDomainError(e, "invalid_input"));
});

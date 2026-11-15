import assert from "node:assert/strict";
import { test } from "node:test";
import { createDateRange, rangeLength, sameRange } from "@/modules/leave/domain/date-range";

const code = (r: ReturnType<typeof createDateRange>) => (r.ok ? "ok" : r.error.code);

test("a range from start to end, end defaulting to start", () => {
  const r = createDateRange("2026-11-02", "2026-11-06");
  assert.ok(r.ok);
  assert.deepEqual(r.value, { startDate: "2026-11-02", endDate: "2026-11-06", dayPortion: "full" });
  assert.equal(rangeLength(r.value), 5);
  const single = createDateRange("2026-11-02", "");
  assert.ok(single.ok);
  assert.equal(single.value.endDate, "2026-11-02");
});

test("refuses an end before the start", () => {
  assert.equal(code(createDateRange("2026-11-06", "2026-11-02")), "invalid_date_range");
});

test("refuses a range over 366 days, and takes one of exactly 366", () => {
  assert.equal(code(createDateRange("2026-01-01", "2027-01-02")), "range_too_long");
  assert.equal(code(createDateRange("2026-01-01", "2027-01-01")), "ok");
});

test("refuses what is not a calendar date, and an unknown portion", () => {
  for (const bad of ["2026-02-30", "26-11-02", "tomorrow", ""]) assert.equal(code(createDateRange(bad, "2026-11-02")), "invalid_input", bad);
  assert.equal(code(createDateRange("2026-11-02", null, "evening" as "am")), "invalid_input");
});

test("a half day covers one date only", () => {
  assert.equal(code(createDateRange("2026-11-02", "2026-11-02", "am")), "ok");
  assert.equal(code(createDateRange("2026-11-02", "2026-11-03", "pm")), "half_day_multi_day");
});

test("ranges are values: equal when their dates and portion are", () => {
  const a = createDateRange("2026-11-02", "2026-11-03");
  const b = createDateRange("2026-11-02", "2026-11-03");
  const c = createDateRange("2026-11-02", "2026-11-02", "am");
  assert.ok(a.ok && b.ok && c.ok);
  assert.notEqual(a.value, b.value);
  assert.ok(sameRange(a.value, b.value));
  assert.ok(!sameRange(a.value, c.value));
});

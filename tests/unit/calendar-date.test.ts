import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { eachDate, fromEpochDay, isCalendarDate, isoWeekday, spanInDays, toEpochDay } from "@/domain/calendar-date";

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

test("accepts real dates and rejects malformed or impossible ones", () => {
  assert.equal(isCalendarDate("2026-11-02"), true);
  assert.equal(isCalendarDate("2024-02-29"), true);
  assert.equal(isCalendarDate("2026-02-29"), false);
  assert.equal(isCalendarDate("2026-02-30"), false);
  assert.equal(isCalendarDate("2026-13-01"), false);
  assert.equal(isCalendarDate("2026-1-2"), false);
  assert.equal(isCalendarDate("2026-11-02T00:00:00Z"), false);
  assert.equal(isCalendarDate(""), false);
});

test("ISO weekday matches the real calendar", () => {
  assert.equal(isoWeekday("1970-01-01"), 4);
  assert.equal(isoWeekday("2026-11-01"), 7);
  assert.equal(isoWeekday("2026-11-02"), 1);
  assert.equal(isoWeekday("2026-11-07"), 6);
  assert.equal(isoWeekday("1969-12-29"), 1);
});

test("iterates inclusively across month and year boundaries", () => {
  assert.deepEqual(eachDate("2026-12-30", "2027-01-02"), ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  assert.deepEqual(eachDate("2024-02-28", "2024-03-01"), ["2024-02-28", "2024-02-29", "2024-03-01"]);
  assert.deepEqual(eachDate("2026-11-02", "2026-11-02"), ["2026-11-02"]);
  assert.deepEqual(eachDate("2026-11-03", "2026-11-02"), []);
  assert.equal(spanInDays("2026-11-02", "2026-11-02"), 1);
  assert.equal(spanInDays("2026-01-01", "2026-12-31"), 365);
});

test("dates never shift with the process time zone, including across DST", () => {
  for (const tz of ["UTC", "America/Chicago", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
    process.env.TZ = tz;
    assert.deepEqual(eachDate("2026-03-07", "2026-03-09"), ["2026-03-07", "2026-03-08", "2026-03-09"], tz);
    assert.deepEqual(eachDate("2026-10-31", "2026-11-02"), ["2026-10-31", "2026-11-01", "2026-11-02"], tz);
    assert.equal(fromEpochDay(toEpochDay("2026-03-08")), "2026-03-08", tz);
    assert.equal(isoWeekday("2026-03-08"), 7, tz);
  }
});

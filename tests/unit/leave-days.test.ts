import assert from "node:assert/strict";
import { test } from "node:test";
import { isDomainError } from "@/domain/errors";
import { countLeaveDays, nextWorkingDay, splitLeaveDaysByYear, type WorkCalendar } from "@/domain/leave-days";
import type { LeaveRange } from "@/domain/leave-request";

const monToFri: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: [] };
const full = (startDate: string, endDate: string): LeaveRange => ({ startDate, endDate, dayPortion: "full" });

// 2026-11-02 is a Monday; 2026-11-26 is a Thursday (US Thanksgiving).

test("counts working weekdays inclusively", () => {
  assert.equal(countLeaveDays(full("2026-11-02", "2026-11-06"), monToFri), 5);
  assert.equal(countLeaveDays(full("2026-11-02", "2026-11-02"), monToFri), 1);
  assert.equal(countLeaveDays(full("2026-11-02", "2026-11-15"), monToFri), 10);
});

test("skips weekends", () => {
  // Friday to Monday is two working days, not four.
  assert.equal(countLeaveDays(full("2026-11-06", "2026-11-09"), monToFri), 2);
  assert.equal(countLeaveDays(full("2026-11-07", "2026-11-08"), monToFri), 0);
});

test("skips company holidays, and only those in range", () => {
  const withHolidays: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: ["2026-11-26", "2026-11-27", "2026-12-25"] };
  assert.equal(countLeaveDays(full("2026-11-23", "2026-11-27"), withHolidays), 3);
  // A holiday on a weekend is not subtracted twice.
  const weekendHoliday: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: ["2026-11-07"] };
  assert.equal(countLeaveDays(full("2026-11-02", "2026-11-08"), weekendHoliday), 5);
});

test("honours a company's own working days", () => {
  const sunToThu: WorkCalendar = { workingDays: [7, 1, 2, 3, 4], holidays: [] };
  assert.equal(countLeaveDays(full("2026-11-01", "2026-11-07"), sunToThu), 5);
  assert.equal(countLeaveDays(full("2026-11-06", "2026-11-07"), sunToThu), 0);
});

test("a half day counts 0.5, and nothing on a day off", () => {
  assert.equal(countLeaveDays({ startDate: "2026-11-02", endDate: "2026-11-02", dayPortion: "am" }, monToFri), 0.5);
  assert.equal(countLeaveDays({ startDate: "2026-11-02", endDate: "2026-11-02", dayPortion: "pm" }, monToFri), 0.5);
  assert.equal(countLeaveDays({ startDate: "2026-11-07", endDate: "2026-11-07", dayPortion: "am" }, monToFri), 0);
  const holiday: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: ["2026-11-02"] };
  assert.equal(countLeaveDays({ startDate: "2026-11-02", endDate: "2026-11-02", dayPortion: "pm" }, holiday), 0);
});

test("rejects malformed ranges before counting", () => {
  const code = (range: LeaveRange) => {
    try {
      countLeaveDays(range, monToFri);
      return "ok";
    } catch (e) {
      return isDomainError(e) ? e.code : "unexpected";
    }
  };
  assert.equal(code(full("2026-11-06", "2026-11-02")), "invalid_date_range");
  assert.equal(code({ startDate: "2026-11-02", endDate: "2026-11-03", dayPortion: "am" }), "half_day_multi_day");
  assert.equal(code(full("2026-01-01", "2027-01-02")), "range_too_long");
  assert.equal(code(full("2026-01-01", "2027-01-01")), "ok");
  assert.equal(code(full("2026-02-30", "2026-03-02")), "invalid_input");
  assert.equal(code({ startDate: "2026-11-02", endDate: "2026-11-02", dayPortion: "evening" as "am" }), "invalid_input");
});

test("the next working day is today on a working day, else the first one after", () => {
  assert.equal(nextWorkingDay("2026-11-02", monToFri), "2026-11-02");
  assert.equal(nextWorkingDay("2026-11-07", monToFri), "2026-11-09", "Saturday");
  assert.equal(nextWorkingDay("2026-11-26", { ...monToFri, holidays: ["2026-11-26", "2026-11-27"] }), "2026-11-30");
  assert.equal(nextWorkingDay("2026-12-31", { workingDays: [5], holidays: [] }), "2027-01-01", "across a year end");
  // Whatever it returns is worth at least one day under the same calendar.
  const calendar = { workingDays: [2, 4], holidays: ["2026-11-03"] };
  const date = nextWorkingDay("2026-11-01", calendar);
  assert.equal(date, "2026-11-05");
  assert.equal(countLeaveDays(full(date, date), calendar), 1);
});

test("with no working day in the look-ahead window, the start date comes back unchanged", () => {
  assert.equal(nextWorkingDay("2026-11-07", { workingDays: [], holidays: [] }), "2026-11-07");
});

test("a request over New Year splits its working days by calendar year", () => {
  // Thu Dec 31 to Mon Jan 4: Dec 31 in 2026; Jan 1 (holiday), Jan 2-3 (weekend), Jan 4 in 2027.
  const newYear: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: ["2027-01-01"] };
  assert.deepEqual(splitLeaveDaysByYear(full("2026-12-31", "2027-01-04"), newYear), [
    { year: 2026, days: 1 },
    { year: 2027, days: 1 },
  ]);
  // Without the holiday, Jan 1 (a Friday) counts in 2027.
  assert.deepEqual(splitLeaveDaysByYear(full("2026-12-31", "2027-01-04"), monToFri), [
    { year: 2026, days: 1 },
    { year: 2027, days: 2 },
  ]);
});

test("a year with no working day in the range is left out of the split", () => {
  // Mon Dec 28 to Sun Jan 3: Jan 1 is a holiday and Jan 2-3 a weekend, so 2027 costs nothing.
  assert.deepEqual(splitLeaveDaysByYear(full("2026-12-28", "2027-01-03"), { ...monToFri, holidays: ["2027-01-01"] }), [
    { year: 2026, days: 4 },
  ]);
  // Only Fri Jan 1 costs anything: Dec 26-27 is a weekend and Dec 28-31 are holidays.
  assert.deepEqual(splitLeaveDaysByYear(full("2026-12-26", "2027-01-01"), { ...monToFri, holidays: ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31"] }), [
    { year: 2027, days: 1 },
  ]);
  assert.deepEqual(splitLeaveDaysByYear(full("2026-11-07", "2026-11-08"), monToFri), []);
});

test("a half day is one year's 0.5, and the split always sums to the total", () => {
  assert.deepEqual(splitLeaveDaysByYear({ startDate: "2026-12-31", endDate: "2026-12-31", dayPortion: "pm" }, monToFri), [
    { year: 2026, days: 0.5 },
  ]);
  const calendar: WorkCalendar = { workingDays: [1, 2, 3, 4, 5], holidays: ["2026-12-25", "2027-01-01"] };
  for (const [start, end] of [
    ["2026-12-01", "2027-02-15"],
    ["2026-01-01", "2027-01-01"],
    ["2026-12-31", "2026-12-31"],
    ["2026-06-01", "2026-06-30"],
  ]) {
    const split = splitLeaveDaysByYear(full(start, end), calendar);
    assert.equal(split.reduce((sum, s) => sum + s.days, 0), countLeaveDays(full(start, end), calendar), `${start}..${end}`);
    assert.ok(split.every((s) => s.days > 0));
  }
});

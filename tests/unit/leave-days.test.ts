import assert from "node:assert/strict";
import { test } from "node:test";
import { isDomainError } from "@/domain/errors";
import { countLeaveDays, nextWorkingDay, requireLeaveDays, type WorkCalendar } from "@/domain/leave-days";
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

test("requireLeaveDays rejects a request that costs nothing, and passes one that does", () => {
  assert.throws(() => requireLeaveDays(full("2026-11-07", "2026-11-08"), monToFri), (e) => isDomainError(e, "zero_days"));
  assert.equal(requireLeaveDays(full("2026-11-06", "2026-11-08"), monToFri), 1);
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

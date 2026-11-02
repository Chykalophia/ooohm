import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  employmentRangeAdjustment,
  isTimeOffApproved,
  scheduleWorkingDays,
  timeOffDeductedDays,
  timeOffYearBalance,
} from "@/domain/timeoff/balance";

const MON_FRI = new Set([1, 2, 3, 4, 5]);
const calendar = (holidays: string[] = [], workingDays = MON_FRI) => ({ workingDays, holidays: new Set(holidays) });
const ALL = 1;
const MORNING = 2;
const AFTERNOON = 3;
const leave = (dateStart: string, dateEnd: string, dayPartStart = ALL, dayPartEnd = ALL) => ({ dateStart, dateEnd, dayPartStart, dayPartEnd });

describe("TimeOff deducted days", () => {
  test("counts working days, skipping weekends and bank holidays", () => {
    // Thu May 21 to Tue May 26 2026: Thu, Fri, (Sat, Sun), Mon = Memorial Day, Tue.
    assert.equal(timeOffDeductedDays(leave("2026-05-21", "2026-05-26"), calendar(["2026-05-25"])), 3);
    assert.equal(timeOffDeductedDays(leave("2026-05-21", "2026-05-26"), calendar()), 4);
  });

  test("a single half day is 0.5, whichever half", () => {
    assert.equal(timeOffDeductedDays(leave("2026-02-16", "2026-02-16", MORNING, MORNING), calendar()), 0.5);
    assert.equal(timeOffDeductedDays(leave("2026-02-16", "2026-02-16", AFTERNOON, ALL), calendar()), 0.5, "only the start part counts");
    assert.equal(timeOffDeductedDays(leave("2026-02-16", "2026-02-16", ALL, MORNING), calendar()), 1, "the end part of a one-day leave is ignored");
  });

  test("half-day ends of a longer leave each take off 0.5", () => {
    // Mon Mar 2 (afternoon) to Wed Mar 4 (morning): 3 days − 0.5 − 0.5.
    assert.equal(timeOffDeductedDays(leave("2026-03-02", "2026-03-04", AFTERNOON, MORNING), calendar()), 2);
    assert.equal(timeOffDeductedDays(leave("2026-03-02", "2026-03-04", AFTERNOON, ALL), calendar()), 2.5);
  });

  test("a leave over New Year is split by the year of each date", () => {
    // Mon Dec 29 2025 to Mon Jan 5 2026, Jan 1 a holiday: 3 days in 2025, 2 in 2026.
    const l = leave("2025-12-29", "2026-01-05");
    const cal = calendar(["2026-01-01"]);
    assert.equal(timeOffDeductedDays(l, cal, 2025), 3);
    assert.equal(timeOffDeductedDays(l, cal, 2026), 2);
    assert.equal(timeOffDeductedDays(l, cal), 5);
  });

  test("the half-day rule follows the leave's first date even when it is filtered out", () => {
    // Wed Dec 31 2025 (afternoon) to Fri Jan 2 2026, Jan 1 a holiday. TimeOff charges 0.5
    // for Dec 31 and also takes 0.5 off the lone Jan 2: 0.5 + 0.5, where the real cost is 1.5.
    const l = leave("2025-12-31", "2026-01-02", AFTERNOON, ALL);
    const cal = calendar(["2026-01-01"]);
    assert.equal(timeOffDeductedDays(l, cal, 2025), 0.5);
    assert.equal(timeOffDeductedDays(l, cal, 2026), 0.5);
    // Sat (afternoon) to Mon: one working day left, still halved.
    assert.equal(timeOffDeductedDays(leave("2026-02-14", "2026-02-16", AFTERNOON, ALL), calendar()), 0.5);
    // Nothing left: never negative.
    assert.equal(timeOffDeductedDays(leave("2026-02-14", "2026-02-14", AFTERNOON, ALL), calendar()), 0);
  });

  test("a personal schedule changes which days count", () => {
    const monThu = new Set(scheduleWorkingDays({ days: [1, 1, 1, 1, 2, 2, 2] }));
    assert.deepEqual([...monThu], [1, 2, 3, 4]);
    assert.equal(timeOffDeductedDays(leave("2026-03-16", "2026-03-20"), calendar([], monThu)), 4);
    // 3 and 4 (half-day schedules) are not full working days.
    assert.deepEqual(scheduleWorkingDays({ days: [1, 3, 4, 1, 1, 2, 2] }), [1, 4, 5]);
  });
});

describe("TimeOff approved statuses", () => {
  test("approved and pended-revoke leave is taken; new, rejected and canceled is not", () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(isTimeOffApproved), [false, true, false, true, false]);
  });
});

describe("TimeOff employment pro-rating", () => {
  const employed = (startDate: string | null, endDate: string | null = null) => ({ startDate, endDate });

  test("a full year changes nothing for ordinary allowances", () => {
    assert.equal(employmentRangeAdjustment(20, employed("2020-01-06"), 2026), 0);
    // D is 364 for a full year, so round(20 × 364 / 365) = round(19.95) = 20.
    assert.equal(employmentRangeAdjustment(25, employed("2026-01-01"), 2026), 0);
  });

  test("starting mid-year pro-rates from the start date to Dec 31", () => {
    // Mar 1 to Dec 31 2026 is 305 days: round(20 × 305 / 365) = round(16.71) = 17.
    assert.equal(employmentRangeAdjustment(20, employed("2026-03-01"), 2026), -3);
    assert.equal(employmentRangeAdjustment(20, employed("2026-03-01"), 2027), 0, "only in the start year");
  });

  test("leaving mid-year pro-rates from Jan 1 to the end date", () => {
    // Jan 1 to Jun 30 2025 is 180 days: round(20 × 180 / 365) = round(9.86) = 10.
    assert.equal(employmentRangeAdjustment(20, employed("2018-01-08", "2025-06-30"), 2025), -10);
    assert.equal(employmentRangeAdjustment(20, employed("2018-01-08", "2025-06-30"), 2024), 0);
  });

  test("starting and leaving in one year uses both dates", () => {
    // Apr 1 to Sep 30 2026 is 182 days: round(24 × 182 / 365) = round(11.97) = 12.
    assert.equal(employmentRangeAdjustment(24, employed("2026-04-01", "2026-09-30"), 2026), -12);
  });

  test("large allowances show TimeOff's fixed 365", () => {
    // round(200 × 364 / 365) = round(199.45) = 199, so even a full start year loses a day.
    assert.equal(employmentRangeAdjustment(200, employed("2026-01-01"), 2026), -1);
  });
});

describe("TimeOff year balance", () => {
  test("total is the allowance, pro-rating, adjustment and carry; remaining subtracts approved days", () => {
    const b = timeOffYearBalance({ year: 2026, nominal: 25, startDate: "2022-01-10", endDate: null, adjustment: 2, carriedOver: 3, used: 5 });
    assert.deepEqual([b.total, b.used, b.remaining, b.beforeStart], [30, 5, 25, false]);
  });

  test("a year before the start date has nothing available", () => {
    const b = timeOffYearBalance({ year: 2025, nominal: 20, startDate: "2026-03-01", endDate: null, adjustment: 0, carriedOver: 0, used: 0 });
    assert.deepEqual([b.remaining, b.beforeStart], [0, true]);
  });

  test("half days add in tenths without floating error", () => {
    const b = timeOffYearBalance({ year: 2026, nominal: 20, startDate: null, endDate: null, adjustment: 0, carriedOver: 0.1, used: 0.2 });
    assert.equal(b.remaining, 19.9);
  });
});

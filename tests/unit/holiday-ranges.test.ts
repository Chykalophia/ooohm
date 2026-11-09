import assert from "node:assert/strict";
import { test } from "node:test";
import { isDomainError } from "@/domain/errors";
import { groupHolidays, HOLIDAY_RANGE_MAX_DAYS, holidayRangeDates } from "@/domain/holidays";

const invalid = (fn: () => unknown) => assert.throws(fn, (e) => isDomainError(e) && e.code === "invalid_input");

test("a holiday range is every day from first to last, weekends and New Year included", () => {
  assert.deepEqual(holidayRangeDates("2026-12-25", "2026-12-25"), ["2026-12-25"]);
  const shutdown = holidayRangeDates("2026-12-21", "2027-01-03");
  assert.equal(shutdown.length, 14);
  assert.equal(shutdown[0], "2026-12-21");
  assert.equal(shutdown.at(-1), "2027-01-03");
  assert.ok(shutdown.includes("2026-12-26"), "the Saturday is in it");
});

test("a holiday range refuses bad dates, a backwards range and one too long", () => {
  invalid(() => holidayRangeDates("2026-02-30", "2026-03-01"));
  invalid(() => holidayRangeDates("2026-12-21", "nope"));
  invalid(() => holidayRangeDates("2026-12-21", "2026-12-20"));
  assert.equal(holidayRangeDates("2026-12-01", "2026-12-31").length, HOLIDAY_RANGE_MAX_DAYS);
  invalid(() => holidayRangeDates("2026-12-01", "2027-01-01"));
});

test("back-to-back days with one name group into one holiday; a gap or another name splits them", () => {
  const rows = [
    { id: "a", date: "2026-12-21", name: "Shutdown" },
    { id: "b", date: "2026-12-22", name: "Shutdown" },
    { id: "c", date: "2026-12-23", name: "Shutdown" },
    { id: "d", date: "2026-12-24", name: "Christmas Eve" },
    { id: "e", date: "2026-12-25", name: "Shutdown" },
    { id: "f", date: "2026-12-31", name: "Shutdown" },
  ];
  assert.deepEqual(
    groupHolidays(rows).map((g) => [g.name, g.startDate, g.endDate, g.days.map((d) => d.id).join("")]),
    [
      ["Shutdown", "2026-12-21", "2026-12-23", "abc"],
      ["Christmas Eve", "2026-12-24", "2026-12-24", "d"],
      ["Shutdown", "2026-12-25", "2026-12-25", "e"],
      ["Shutdown", "2026-12-31", "2026-12-31", "f"],
    ],
  );
  assert.deepEqual(groupHolidays([]), []);
});

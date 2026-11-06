import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgenda, yearHasHolidays } from "@/domain/calendar";
import { isSettledAway } from "@/components/leave/request-tone";
import { fieldClass, selectClass } from "@/components/ui/styles";

const WEEKDAYS = [1, 2, 3, 4, 5];

function yearOf(holidays: { date: string; name: string }[]) {
  return Array.from({ length: 12 }, (_, i) => {
    const month = `2027-${String(i + 1).padStart(2, "0")}`;
    return { agenda: buildAgenda({ month, workingDays: WEEKDAYS, holidays, entries: [] }) };
  });
}

test("a year knows whether the company added any holidays to it", () => {
  assert.equal(yearHasHolidays(yearOf([])), false, "none added");
  assert.equal(yearHasHolidays(yearOf([{ date: "2027-08-17", name: "Independence Day" }])), true, "one in August");
  // The January grid starts in late December, but last year's holidays don't count for this one.
  assert.equal(yearHasHolidays(yearOf([{ date: "2026-12-28", name: "Collective leave" }])), false, "only last year's");
});

test("cancelled and declined requests are shown greyed out, booked ones in colour", () => {
  assert.equal(isSettledAway("cancelled"), true);
  assert.equal(isSettledAway("rejected"), true);
  assert.equal(isSettledAway("approved"), false);
  assert.equal(isSettledAway("pending"), false);
});

test("a select leaves 4px more room on the right than a text field, for its chevron", () => {
  assert.match(fieldClass("md"), /\bpx-3\b/);
  assert.match(selectClass("md"), /\bpr-4\b/, "12px + 4px");
  assert.match(fieldClass("sm"), /\bpx-2\.5\b/);
  assert.match(selectClass("sm"), /\bpr-3\.5\b/, "10px + 4px");
});

test("a select sets its left and right padding apart, never on top of a field's px-*", () => {
  for (const size of ["md", "sm"] as const) {
    const classes = selectClass(size).split(" ");
    assert.ok(!classes.some((c) => /^px-/.test(c)), `${size}: no px-* to fight pr-*`);
  }
  assert.match(selectClass("md"), /\bpl-3\b/);
  assert.match(selectClass("sm"), /\bpl-2\.5\b/);
});

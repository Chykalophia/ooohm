import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initialFocus, isSelectable, localToday, moveFocus, parseTyped, pickerGrid } from "@/components/forms/date-picker-grid";
import { isCalendarDate } from "@/domain/calendar-date";

describe("date picker grid", () => {
  test("AC1(a) pickerGrid(2026-11) is 42 days from 2026-10-26 to 2026-12-06, 12 outside November", () => {
    const grid = pickerGrid("2026-11");
    assert.equal(grid.length, 42);
    assert.equal(grid[0].date, "2026-10-26");
    assert.equal(grid[41].date, "2026-12-06");
    const outside = grid.filter((d) => !d.inMonth).map((d) => d.date);
    assert.equal(outside.length, 12);
    assert.deepEqual(outside, [
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-12-01",
      "2026-12-02",
      "2026-12-03",
      "2026-12-04",
      "2026-12-05",
      "2026-12-06",
    ]);
    assert.ok(grid.filter((d) => d.inMonth).every((d) => d.date.startsWith("2026-11-")));
  });

  test("pickerGrid always gives 6 Monday-first weeks (February 2027 starts on a Monday)", () => {
    const grid = pickerGrid("2027-02");
    assert.equal(grid.length, 42);
    assert.equal(grid[0].date, "2027-02-01");
    assert.equal(grid[41].date, "2027-03-14");
  });

  test("AC1(b) PageDown keeps the day number, clamped to the month's last day", () => {
    assert.equal(moveFocus("2026-01-31", "PageDown"), "2026-02-28");
    assert.equal(moveFocus("2024-01-31", "PageDown"), "2024-02-29");
    assert.equal(moveFocus("2026-03-31", "PageUp"), "2026-02-28");
    assert.equal(moveFocus("2026-11-09", "PageUp"), "2026-10-09");
  });

  test("Shift+PageUp/PageDown move a year, with the same clamping", () => {
    assert.equal(moveFocus("2024-02-29", "PageDown", true), "2025-02-28");
    assert.equal(moveFocus("2026-11-09", "PageUp", true), "2025-11-09");
  });

  test("AC1(c) Home and End go to the Monday and Sunday of the week", () => {
    assert.equal(moveFocus("2026-11-11", "Home"), "2026-11-09");
    assert.equal(moveFocus("2026-11-11", "End"), "2026-11-15");
    assert.equal(moveFocus("2026-11-09", "Home"), "2026-11-09");
    assert.equal(moveFocus("2026-11-15", "End"), "2026-11-15");
  });

  test("AC1(d) arrow keys move ±1 and ±7 days across month and year boundaries", () => {
    assert.equal(moveFocus("2026-12-31", "ArrowRight"), "2027-01-01");
    assert.equal(moveFocus("2027-01-01", "ArrowLeft"), "2026-12-31");
    assert.equal(moveFocus("2026-12-28", "ArrowDown"), "2027-01-04");
    assert.equal(moveFocus("2027-01-04", "ArrowUp"), "2026-12-28");
    assert.equal(moveFocus("2026-11-30", "ArrowRight"), "2026-12-01");
  });

  test("AC1(e) isSelectable refuses days before min", () => {
    assert.equal(isSelectable("2026-11-08", "2026-11-09"), false);
    assert.equal(isSelectable("2026-11-09", "2026-11-09"), true);
    assert.equal(isSelectable("2026-11-10", "2026-11-09"), true);
    assert.equal(isSelectable("2026-11-08"), true);
  });

  test("AC1(f) parseTyped accepts only a real YYYY-MM-DD", () => {
    assert.equal(parseTyped("2026-02-30"), null);
    assert.equal(parseTyped("11/09/2026"), null);
    assert.equal(parseTyped("2026-11-09"), "2026-11-09");
    assert.equal(parseTyped(""), null);
    assert.equal(parseTyped("2026-1-9"), null);
  });

  test("initialFocus prefers the value, then today, and never goes before min", () => {
    assert.equal(initialFocus("2026-11-23", "2026-11-09"), "2026-11-23");
    assert.equal(initialFocus("", "2026-11-09"), "2026-11-09");
    assert.equal(initialFocus("", "2026-11-09", "2026-11-20"), "2026-11-20");
    assert.equal(initialFocus("2026-11-10", "2026-11-09", "2026-11-20"), "2026-11-20");
    assert.equal(initialFocus("2026-11-25", "2026-11-09", "2026-11-20"), "2026-11-25");
  });

  test("localToday reads the device's local date", () => {
    assert.equal(localToday(new Date(2026, 10, 9, 23, 59)), "2026-11-09");
    assert.equal(localToday(new Date(2027, 0, 1, 0, 0)), "2027-01-01");
  });
});

test("regression: focus clamps at the first and last supported days", async () => {
  const { moveFocus, pickerGrid } = await import("@/components/forms/date-picker-grid");
  assert.equal(moveFocus("9999-12-31", "ArrowRight"), "9999-12-31");
  assert.equal(moveFocus("9999-12-30", "ArrowDown"), "9999-12-31");
  assert.equal(moveFocus("9999-12-15", "PageDown"), "9999-12-31");
  assert.equal(moveFocus("0100-01-01", "ArrowLeft"), "0100-01-01");
  const grid = pickerGrid("9999-12");
  assert.equal(grid.length, 42);
  assert.equal(grid[41].date, "9999-12-31");
});

describe("date picker agrees with the shared validator (isCalendarDate)", () => {
  // Every day the picker lets a person pick or type, the server accepts too.
  const edges = [
    "0099-12-27",
    "0099-12-31",
    "0100-01-01",
    "0100-01-02",
    "0100-02-28",
    "0100-02-29",
    "9999-12-30",
    "9999-12-31",
  ];

  test("MIN_DATE and MAX_DATE are the first and last days isCalendarDate accepts", async () => {
    const { MIN_DATE, MAX_DATE } = await import("@/components/forms/date-picker-grid");
    assert.equal(isCalendarDate(MIN_DATE), true);
    assert.equal(isCalendarDate("0099-12-31"), false);
    assert.equal(isCalendarDate(MAX_DATE), true);
    assert.equal(isCalendarDate("10000-01-01"), false);
  });

  test("low edge: every selectable cell of the 0100-01 grid passes isCalendarDate; the 0099 cells are disabled", () => {
    const grid = pickerGrid("0100-01");
    assert.equal(grid[0].date, "0099-12-28");
    for (const { date } of grid) assert.equal(isSelectable(date), isCalendarDate(date), date);
    assert.equal(isSelectable("0099-12-31"), false);
    assert.equal(isSelectable("0100-01-01"), true);
  });

  test("high edge: every selectable cell of the 9999-12 grid passes isCalendarDate", () => {
    for (const { date } of pickerGrid("9999-12")) assert.equal(isSelectable(date), isCalendarDate(date), date);
  });

  test("typed entry accepts exactly what isCalendarDate accepts at the edges", () => {
    for (const text of edges) assert.equal(parseTyped(text) !== null, isCalendarDate(text), text);
    assert.equal(parseTyped("0050-06-15"), null);
  });

  test("keyboard and month navigation never land on a day isCalendarDate refuses", () => {
    const keys = ["ArrowLeft", "ArrowUp", "Home", "PageUp"] as const;
    for (const key of keys) {
      for (const shift of [false, true]) {
        for (const from of ["0100-01-01", "0100-01-15", "0100-06-30", "0100-12-31"]) {
          const to = moveFocus(from, key, shift);
          assert.ok(isCalendarDate(to), `${from} ${key}${shift ? "+shift" : ""} -> ${to}`);
        }
      }
    }
    for (const key of ["ArrowRight", "ArrowDown", "End", "PageDown"] as const) {
      for (const shift of [false, true]) {
        for (const from of ["9999-12-31", "9999-12-15", "9999-01-31"]) {
          const to = moveFocus(from, key, shift);
          assert.ok(isCalendarDate(to), `${from} ${key}${shift ? "+shift" : ""} -> ${to}`);
        }
      }
    }
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initialFocus, isSelectable, localToday, moveFocus, parseTyped, pickerGrid } from "@/components/forms/date-picker-grid";

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

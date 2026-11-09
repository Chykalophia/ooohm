import assert from "node:assert/strict";
import { test } from "node:test";
import { pickerGrid } from "@/components/forms/date-picker-grid";
import { isoWeekday } from "@/domain/calendar-date";

test("attack: picker grid near MAX_DATE must align with Monday-first header", () => {
  const grid = pickerGrid("9999-12");
  // The clamping logic near MAX_DATE forces the grid to start on a Saturday (6), misaligning all days with the Monday-first header (R4).
  assert.equal(isoWeekday(grid[0].date), 1, `Grid for 9999-12 starts on ${grid[0].date} which is not a Monday`);
});

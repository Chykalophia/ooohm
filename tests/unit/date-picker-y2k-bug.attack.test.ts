import assert from "node:assert/strict";
import { test } from "node:test";
import { pickerGrid } from "@/components/forms/date-picker-grid";

test("picker grid at year 100 does not jump to year 1999 due to Date.UTC year 0-99 behavior", () => {
  const grid = pickerGrid("0100-01");
  // The first day of the grid should be in year 0099 (e.g. 0099-12-31), NOT year 1999
  const firstDay = grid[0].date;
  assert.match(firstDay, /^0099-/, "First day of 0100-01 grid should be in year 0099");
});

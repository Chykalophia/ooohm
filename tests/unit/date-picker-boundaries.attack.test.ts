import assert from "node:assert/strict";
import { test } from "node:test";
import { moveFocus, pickerGrid } from "@/components/forms/date-picker-grid";

test("picker navigation at the last representable year never creates malformed dates", () => {
  // The final supported date must not become a six-digit year when keyboard navigation advances it.
  assert.match(moveFocus("9999-12-31", "ArrowRight"), /^\d{4}-\d{2}-\d{2}$/);
});

test("December 9999 grid contains only four-digit calendar dates", () => {
  // A final-month grid must not leak expanded ISO years that cannot be posted as CalendarDate values.
  assert.ok(pickerGrid("9999-12").every(({ date }) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
});

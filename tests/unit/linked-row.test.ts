import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedRow } from "@/components/ui/styles";

test("linkedRow tints on link hover and focus, with an eased transition", () => {
  assert.match(linkedRow, /transition-colors/);
  assert.ok(linkedRow.includes("has-[a[href]:hover]:bg-background"));
  assert.ok(linkedRow.includes("has-[a[href]:focus-visible]:bg-background"));
});

test("linkedRow uses theme tokens only", () => {
  assert.doesNotMatch(linkedRow, /dark:|(gray|slate|zinc|neutral|stone)-\d/);
});

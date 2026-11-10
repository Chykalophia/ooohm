import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedRow } from "@/components/ui/styles";

test("linkedRow tints on link hover and on keyboard focus", () => {
  assert.ok(linkedRow.includes("has-[a[href]:hover]:bg-linear-to-b"));
  assert.ok(linkedRow.includes("has-[a[href]:focus-visible]:bg-linear-to-b"));
});

// Tonal colours cards with an unlayered `background-color` in globals.css, which beats any
// Tailwind background colour. A tint drawn as a background colour vanished there (the
// production layout), so the tint must be an image laid over the row's own colour.
test("linkedRow lays its tint over the background instead of replacing the background colour", () => {
  assert.doesNotMatch(linkedRow, /\bbg-(background|surface|accent)\b/);
  assert.match(linkedRow, /from-accent\/\d+ to-accent\/\d+/);
});

test("linkedRow uses theme tokens only", () => {
  assert.doesNotMatch(linkedRow, /dark:|(gray|slate|zinc|neutral|stone)-\d/);
});

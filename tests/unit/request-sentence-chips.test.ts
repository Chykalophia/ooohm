import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// AC6: at 320px a long leave-type name ("PTO (Scheduled Time Off)") must wrap inside its chip,
// not push the page wider than the viewport. nowrap is only allowed from the sm breakpoint up.
test("sentence chips only refuse to wrap from sm up", () => {
  const src = readFileSync("src/app/request-leave-sentence.tsx", "utf8");
  const token = src.slice(src.indexOf("const token = cx("), src.indexOf("const PORTION_WORDS"));
  assert.doesNotMatch(token, /(^|[\s"])whitespace-nowrap/);
  assert.match(token, /sm:whitespace-nowrap/);
});

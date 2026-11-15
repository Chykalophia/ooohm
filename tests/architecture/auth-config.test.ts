import assert from "node:assert/strict";
import { test } from "node:test";
import { read } from "./files";

/**
 * F18 (ADR-0005): Better Auth's session cookie cache stays off, so `getSession()` reads
 * the session table on every request and a revoked or deactivated session ends at once.
 */
test("Better Auth's cookie cache is not turned on", () => {
  const source = read("src/lib/auth.ts");
  const cache = source.match(/cookieCache\s*:\s*\{[^}]*\}/);
  if (cache) assert.match(cache[0], /enabled\s*:\s*false/, "cookieCache must stay disabled unless an ADR says otherwise");
});

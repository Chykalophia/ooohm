import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { read, ROOT } from "./files";

/**
 * Every fitness function is an error with no baseline (ADR-0012): `pnpm arch` reports every
 * dependency violation, so there is no known-violations file for it to skip.
 */
test("pnpm arch has no baseline to skip violations with", () => {
  assert.equal(existsSync(join(ROOT, ".dependency-cruiser-known-violations.json")), false, "fix the violation instead of recording it");
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
  assert.ok(scripts.arch, "pnpm arch is missing");
  assert.doesNotMatch(scripts.arch, /--ignore-known/);
  assert.equal(scripts["arch:baseline"], undefined);
});

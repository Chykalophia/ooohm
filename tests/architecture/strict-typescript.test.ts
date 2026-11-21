import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { read, ROOT } from "./files";

/**
 * The whole repository (src, tests, scripts, site/demo, e2e and the config files)
 * compiles with the strict flags on top of `strict`, set in the base tsconfig.json, and
 * `pnpm typecheck`, which CI runs, is that one pass.
 */
const FLAGS = ["noUncheckedIndexedAccess", "exactOptionalPropertyTypes", "noImplicitOverride", "noFallthroughCasesInSwitch"];

interface TsConfig {
  extends?: string;
  compilerOptions: Record<string, unknown>;
  include: string[];
  exclude?: string[];
}

test("tsconfig.json turns on strict and the strict flags for every file", () => {
  const config = JSON.parse(read("tsconfig.json")) as TsConfig;
  assert.equal(config.extends, undefined, "the base config stands alone");
  assert.equal(config.compilerOptions.strict, true);
  for (const flag of FLAGS) assert.equal(config.compilerOptions[flag], true, `${flag} is off`);
  for (const pattern of ["**/*.ts", "**/*.tsx", "**/*.mts"]) assert.ok(config.include.includes(pattern), `${pattern} is checked`);
  assert.deepEqual(config.exclude ?? [], ["node_modules"], "nothing but node_modules is left out");
});

test("pnpm typecheck is one pass over the base config", () => {
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts.typecheck, "tsc --noEmit");
  assert.ok(!existsSync(join(ROOT, "tsconfig.src.json")), "no second, stricter config for part of the tree");
});

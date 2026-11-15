import assert from "node:assert/strict";
import { test } from "node:test";
import { read } from "./files";

/**
 * `src` compiles with the strict flags on top of `strict` (tsconfig.src.json), and
 * `pnpm typecheck`, which CI runs, checks it with them. Tests and scripts stay on the base
 * config.
 */
const FLAGS = ["noUncheckedIndexedAccess", "exactOptionalPropertyTypes", "noImplicitOverride", "noFallthroughCasesInSwitch"];

test("tsconfig.src.json turns on the strict flags for src", () => {
  const config = JSON.parse(read("tsconfig.src.json")) as { extends: string; compilerOptions: Record<string, unknown>; include: string[] };
  assert.equal(config.extends, "./tsconfig.json");
  assert.equal((JSON.parse(read("tsconfig.json")) as { compilerOptions: { strict?: boolean } }).compilerOptions.strict, true);
  for (const flag of FLAGS) assert.equal(config.compilerOptions[flag], true, `${flag} is off`);
  assert.ok(config.include.includes("src/**/*.ts") && config.include.includes("src/**/*.tsx"));
});

test("pnpm typecheck checks src with tsconfig.src.json", () => {
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
  assert.match(scripts.typecheck ?? "", /tsc --noEmit -p tsconfig\.src\.json/);
});

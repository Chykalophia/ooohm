import assert from "node:assert/strict";
import { test } from "node:test";
import * as balances from "@/modules/balances";

/**
 * AGENTS.md: every balance reads a person's default allowance through
 * `loadAllowanceDefaults`. So the module hands out that loader and the reads built on
 * it, never the rule arithmetic that turns a type's own default into a person's, nor a
 * repository that would read allowances around it.
 */
test("the index exports loadAllowanceDefaults, and not the rule arithmetic or a repository", () => {
  const exported = Object.keys(balances);
  assert.ok(exported.includes("loadAllowanceDefaults"));
  for (const name of ["defaultAllowanceFor", "ruleFor", "typeDefaults", "allowanceDefaultsFrom", "AnnualCalendarYearPolicy", "balancesStore", "balancesDeps"]) {
    assert.ok(!exported.includes(name), `${name} stays inside the module`);
  }
  assert.deepEqual(exported.filter((name) => /^drizzle|Repository$/.test(name)), []);
});

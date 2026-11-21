import assert from "node:assert/strict";
import { test } from "node:test";
import { type AllowanceRule, allowanceDefaultsFrom, defaultAllowanceFor, typeDefaults } from "@/modules/balances/domain/allowance-rules";
import { at } from "../../../support/present";

const vacation = { id: "vac", defaultAllowanceDays: 20 };
const rules: AllowanceRule[] = [
  { leaveTypeId: "vac", departmentId: "dev", levelId: null, days: 22 },
  { leaveTypeId: "vac", departmentId: null, levelId: "senior", days: 25 },
  { leaveTypeId: "vac", departmentId: "dev", levelId: "senior", days: 28 },
];
// Listed in every order, so the winner never depends on which rule came first.
const orders = [rules, [...rules].reverse(), [at(rules, 2), at(rules, 0), at(rules, 1)]];

test("a department and level rule beats a level rule, which beats a department rule, which beats the type's default", () => {
  for (const list of orders) {
    assert.equal(defaultAllowanceFor(vacation, { departmentId: "dev", levelId: "senior" }, list), 28, "department + level");
    assert.equal(defaultAllowanceFor(vacation, { departmentId: "ops", levelId: "senior" }, list), 25, "level");
    assert.equal(defaultAllowanceFor(vacation, { departmentId: "dev", levelId: "junior" }, list), 22, "department");
    assert.equal(defaultAllowanceFor(vacation, { departmentId: "ops", levelId: null }, list), 20, "the type's default");
  }
});

test("a level rule beats a department rule even without the department and level rule", () => {
  const twoRules = rules.slice(0, 2);
  assert.equal(defaultAllowanceFor(vacation, { departmentId: "dev", levelId: "senior" }, twoRules), 25);
});

test("a rule of another leave type never applies, and a type without a default stays without one", () => {
  assert.equal(defaultAllowanceFor({ id: "sick", defaultAllowanceDays: null }, { departmentId: "dev", levelId: "senior" }, rules), null);
});

test("the company's defaults read each person's placement; with no rules every type keeps its own default", () => {
  const defaults = allowanceDefaultsFrom(rules, new Map([["ana", { departmentId: "dev", levelId: "senior" }]]));
  assert.equal(defaults("ana", vacation), 28);
  assert.equal(defaults("someone-else", vacation), 20, "a person not placed sits nowhere");
  assert.equal(allowanceDefaultsFrom([], new Map()), typeDefaults);
  assert.equal(typeDefaults("ana", vacation), 20);
});

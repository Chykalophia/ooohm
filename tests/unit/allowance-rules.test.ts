import assert from "node:assert/strict";
import { test } from "node:test";
import { type AllowanceRule, defaultAllowanceFor, normalizeAllowanceRule, ruleFor } from "@/domain/allowance-rules";
import { isDomainError } from "@/domain/errors";

const pto = { id: "pto", defaultAllowanceDays: 15 };
const rules: AllowanceRule[] = [
  { leaveTypeId: "pto", departmentId: "dev", levelId: null, days: 20 },
  { leaveTypeId: "pto", departmentId: null, levelId: "intern", days: 10 },
  { leaveTypeId: "pto", departmentId: "dev", levelId: "senior", days: 25 },
  { leaveTypeId: "sick", departmentId: "dev", levelId: null, days: 8 },
];

test("without a matching rule a person gets the leave type's default", () => {
  assert.equal(defaultAllowanceFor(pto, { departmentId: null, levelId: null }, rules), 15);
  assert.equal(defaultAllowanceFor(pto, { departmentId: "sales", levelId: "senior" }, rules), 15, "senior alone has no PTO rule");
  assert.equal(defaultAllowanceFor({ id: "other", defaultAllowanceDays: null }, { departmentId: "dev", levelId: null }, rules), null);
});

test("a department's rule replaces the default for its people", () => {
  assert.equal(defaultAllowanceFor(pto, { departmentId: "dev", levelId: null }, rules), 20);
  assert.equal(defaultAllowanceFor({ id: "sick", defaultAllowanceDays: 5 }, { departmentId: "dev", levelId: null }, rules), 8);
});

test("the most specific rule wins: department and level, then level, then department", () => {
  assert.equal(defaultAllowanceFor(pto, { departmentId: "dev", levelId: "senior" }, rules), 25);
  assert.equal(defaultAllowanceFor(pto, { departmentId: "dev", levelId: "intern" }, rules), 10, "an intern's level beats the department");
  assert.equal(defaultAllowanceFor(pto, { departmentId: "sales", levelId: "intern" }, rules), 10);
  assert.deepEqual(ruleFor(rules, "pto", { departmentId: "dev", levelId: "senior" })?.days, 25);
});

test("a rule gives a type without a default an allowance", () => {
  const unset = { id: "pto", defaultAllowanceDays: null };
  assert.equal(defaultAllowanceFor(unset, { departmentId: "dev", levelId: null }, rules), 20);
});

test("a rule names a department, a level or both, and days in tenths from 0 to 366", () => {
  assert.deepEqual(normalizeAllowanceRule({ departmentId: "d", levelId: null, days: 12.5 }), { departmentId: "d", levelId: null, days: 12.5 });
  const refused = (input: Parameters<typeof normalizeAllowanceRule>[0]) =>
    assert.throws(() => normalizeAllowanceRule(input), (e) => isDomainError(e, "invalid_input"));
  refused({ departmentId: null, levelId: null, days: 10 });
  refused({ departmentId: "d", levelId: null, days: -1 });
  refused({ departmentId: "d", levelId: null, days: 367 });
  refused({ departmentId: "d", levelId: null, days: 1.25 });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { isDomainError } from "@/shared/kernel/errors";
import type { AllowancePolicy, Balance } from "@/modules/balances/domain/allowance-policy";
import { AnnualCalendarYearPolicy } from "@/modules/balances/domain/annual-calendar-year-policy";
import { AllowancePolicyRegistry, allowancePolicies, resolveAllowancePolicy } from "@/modules/balances/domain/policy-registry";
import { ALLOWANCE_POLICY_KEYS, ANNUAL_CALENDAR_YEAR } from "@/shared/kernel/allowance-policy-keys";

/** A policy that is not the v1 one, to show the registry takes any. */
const everythingUnlimited: AllowancePolicy = {
  key: "unlimited",
  periodsFor: () => [],
  balance: ({ booked }): Balance => ({ tracked: false, used: booked.approved, pending: booked.pending }),
  carryover: () => null,
};

test("annual_calendar_year resolves through the policy registry to the annual calendar year strategy", () => {
  const policy = resolveAllowancePolicy(ANNUAL_CALENDAR_YEAR);
  assert.ok(policy instanceof AnnualCalendarYearPolicy);
  assert.equal(policy.key, ANNUAL_CALENDAR_YEAR);
  assert.equal(allowancePolicies.resolve(ANNUAL_CALENDAR_YEAR), policy);
});

test("the registry answers to exactly the policy keys the company settings offer", () => {
  assert.deepEqual(allowancePolicies.keys(), [...ALLOWANCE_POLICY_KEYS]);
});

test("another policy plugs in by key, and nothing else branches on it", () => {
  const registry = new AllowancePolicyRegistry([new AnnualCalendarYearPolicy()]).register(everythingUnlimited);
  assert.deepEqual(registry.keys(), [ANNUAL_CALENDAR_YEAR, "unlimited"]);
  const policy = registry.resolve("unlimited");
  assert.deepEqual(policy.balance({ leaveType: { countsAgainstAllowance: true, defaultAllowanceDays: 20, carryoverEnabled: false, carryoverMaxDays: null }, allowance: null, booked: { approved: 3, pending: 1 } }), {
    tracked: false,
    used: 3,
    pending: 1,
  });
  assert.throws(() => registry.register(everythingUnlimited), /already registered/);
});

test("an unknown key is policy_unavailable rather than a quiet fallback", () => {
  assert.throws(
    () => resolveAllowancePolicy("weekly"),
    (e) => isDomainError(e) && e.code === "policy_unavailable",
  );
});

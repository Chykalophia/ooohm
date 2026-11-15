import assert from "node:assert/strict";
import { test } from "node:test";
import { typeDefaults } from "@/modules/balances/domain/allowance-rules";
import { type Allowance, allowanceYearsFor, balanceInputs } from "@/modules/balances/domain/allowance";
import { AnnualCalendarYearPolicy } from "@/modules/balances/domain/annual-calendar-year-policy";

const policy = new AnnualCalendarYearPolicy();
const vacation = { id: "vac", countsAgainstAllowance: true, defaultAllowanceDays: 20, carryoverEnabled: false, carryoverMaxDays: null };
const row = (over: Partial<Allowance>): Allowance => ({ id: "row", userId: "ana", leaveTypeId: "vac", year: 2026, days: 20, carriedOverDays: 0, adjustmentDays: 0, ...over });

test("available = days + carried over + adjustment - used, to one decimal place", () => {
  const b = policy.balance({
    leaveType: vacation,
    allowance: { days: 20.1, carriedOverDays: 0.2, adjustmentDays: 0.1 },
    booked: { approved: 0.3, pending: 0 },
  });
  assert.ok(b.tracked);
  assert.equal(b.total, 20.4);
  assert.equal(b.remaining, 20.1, "no binary drift: 20.1 + 0.2 + 0.1 - 0.3");
  assert.equal(b.used, 0.3);
});

test("half days count 0.5 and a negative adjustment lowers what is available", () => {
  const b = policy.balance({ leaveType: vacation, allowance: { days: 15, carriedOverDays: 2.5, adjustmentDays: -1 }, booked: { approved: 3.5, pending: 0.5 } });
  assert.ok(b.tracked);
  assert.equal(b.remaining, 12.5);
});

test("the balance lookup reads the year's row, its bookings and what was carried out into the next year", () => {
  const inputs = balanceInputs(
    [row({ year: 2026, days: 20, adjustmentDays: 1.5 }), row({ id: "next", year: 2027, carriedOverDays: 4 })],
    [{ userId: "ana", leaveTypeId: "vac", year: 2026, approved: 5.5, pending: 1 }],
    typeDefaults,
  );
  const b = inputs.balance(policy, vacation, "ana", 2026);
  assert.ok(b.tracked);
  assert.deepEqual([b.total, b.used, b.pending, b.carriedOut, b.remaining], [21.5, 5.5, 1, 4, 11]);
  assert.deepEqual(allowanceYearsFor([2026, 2027]), [2026, 2027, 2028]);
});

test("without a row the person's default applies, and a type without one inherits the latest earlier row", () => {
  const defaults = () => 25;
  assert.equal((balanceInputs([], [], defaults).balance(policy, vacation, "ana", 2026) as { allowance: number }).allowance, 25);
  const noDefault = { ...vacation, defaultAllowanceDays: null };
  const inherited = balanceInputs([row({ year: 2024, days: 12 })], [], typeDefaults).balance(policy, noDefault, "ana", 2026);
  assert.ok(inherited.tracked);
  assert.equal(inherited.allowance, 12);
});

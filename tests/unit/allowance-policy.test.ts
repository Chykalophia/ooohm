import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays,
  AnnualCalendarYearPolicy,
  assertCovered,
  type Balance,
  type BalanceInput,
  findShortfall,
  type LeaveTypeAllowanceSettings,
  remainingAfter,
  resolveAllowancePolicy,
} from "@/domain/allowance-policy";
import { isDomainError } from "@/domain/errors";

const policy = new AnnualCalendarYearPolicy();

const pto: LeaveTypeAllowanceSettings = {
  countsAgainstAllowance: true,
  defaultAllowanceDays: 15,
  carryoverEnabled: false,
  carryoverMaxDays: null,
};
const nothing = { approved: 0, pending: 0 };
const balance = (input: Partial<BalanceInput>) => policy.balance({ leaveType: pto, allowance: null, booked: nothing, ...input });

function tracked(b: Balance) {
  assert.ok(b.tracked, "expected a tracked balance");
  return b;
}

test("without an allowance row the type's default applies; a row replaces it and adds carryover and adjustment", () => {
  assert.deepEqual(balance({ booked: { approved: 3, pending: 1.5 } }), {
    tracked: true,
    allowance: 15,
    carriedOver: 0,
    adjustment: 0,
    total: 15,
    used: 3,
    pending: 1.5,
    carriedOut: 0,
    remaining: 10.5,
  });

  const withRow = tracked(
    balance({ allowance: { days: 20, carriedOverDays: 4, adjustmentDays: -1.5 }, booked: { approved: 2.5, pending: 0 } }),
  );
  assert.equal(withRow.allowance, 20);
  assert.equal(withRow.total, 22.5);
  assert.equal(withRow.remaining, 20);
});

test("pending days are committed: they reduce remaining just like approved ones", () => {
  const approved = tracked(balance({ booked: { approved: 4, pending: 0 } }));
  const pending = tracked(balance({ booked: { approved: 0, pending: 4 } }));
  assert.equal(approved.remaining, pending.remaining);
  assert.equal(approved.used, 4);
  assert.equal(pending.used, 0);
  assert.equal(pending.pending, 4);
});

test("a row with zero days still tracks the type even when the default is unlimited", () => {
  const unlimitedByDefault = { ...pto, defaultAllowanceDays: null };
  assert.equal(policy.balance({ leaveType: unlimitedByDefault, allowance: null, booked: nothing }).tracked, false);
  const limited = tracked(
    policy.balance({ leaveType: unlimitedByDefault, allowance: { days: 0, carriedOverDays: 0, adjustmentDays: 2 }, booked: nothing }),
  );
  assert.equal(limited.remaining, 2);
});

test("a type without a default inherits the person's earlier allowance; a default or the year's own row wins over it", () => {
  const noDefault = { ...pto, defaultAllowanceDays: null };
  const inherited = tracked(policy.balance({ leaveType: noDefault, allowance: null, inheritedDays: 5, booked: { approved: 1, pending: 0.5 } }));
  assert.deepEqual(inherited, {
    tracked: true, allowance: 5, carriedOver: 0, adjustment: 0, total: 5, used: 1, pending: 0.5, carriedOut: 0, remaining: 3.5,
  });
  // Mirror: nothing to inherit (never had a row) stays unlimited.
  assert.equal(policy.balance({ leaveType: noDefault, allowance: null, inheritedDays: null, booked: nothing }).tracked, false);
  // An inherited zero still limits.
  assert.equal(tracked(policy.balance({ leaveType: noDefault, allowance: null, inheritedDays: 0, booked: nothing })).remaining, 0);
  // The year's own row wins over the inherited one.
  const own = { days: 2, carriedOverDays: 1, adjustmentDays: 0 };
  assert.equal(tracked(policy.balance({ leaveType: noDefault, allowance: own, inheritedDays: 5, booked: nothing })).total, 3);
  // With a default, the default applies, not an earlier custom row.
  assert.equal(tracked(balance({ inheritedDays: 30 })).allowance, 15);
  // Not counting against allowance stays untracked whatever there is to inherit.
  assert.equal(policy.balance({ leaveType: { ...noDefault, countsAgainstAllowance: false }, allowance: null, inheritedDays: 5, booked: nothing }).tracked, false);
});

test("types that don't count against allowance are untracked even with an allowance row, and still report usage", () => {
  const sick = { ...pto, countsAgainstAllowance: false };
  assert.deepEqual(
    policy.balance({ leaveType: sick, allowance: { days: 5, carriedOverDays: 0, adjustmentDays: 0 }, booked: { approved: 2, pending: 0.5 } }),
    { tracked: false, used: 2, pending: 0.5 },
  );
});

test("tenths add up exactly", () => {
  assert.equal(addDays(0.1, 0.2), 0.3);
  const b = tracked(balance({ allowance: { days: 0.1, carriedOverDays: 0.2, adjustmentDays: 0 }, booked: nothing }));
  assert.equal(b.total, 0.3);
  assert.equal(remainingAfter(b, 0.1), 0.2);
});

test("remaining may go negative when an allowance is lowered after booking", () => {
  const b = tracked(balance({ allowance: { days: 2, carriedOverDays: 0, adjustmentDays: 0 }, booked: { approved: 3, pending: 0 } }));
  assert.equal(b.remaining, -1);
});

test("carryover: off by default, clamped to [0, max] when on, uncapped when max is null, nothing for untracked", () => {
  const withRemaining = (remaining: number) => balance({ allowance: { days: remaining, carriedOverDays: 0, adjustmentDays: 0 } });
  assert.equal(policy.carryover(pto, withRemaining(7)), null);

  const capped = { ...pto, carryoverEnabled: true, carryoverMaxDays: 5 };
  assert.equal(policy.carryover(capped, withRemaining(7)), 5);
  assert.equal(policy.carryover(capped, withRemaining(3.5)), 3.5);
  assert.equal(policy.carryover(capped, withRemaining(0)), 0);
  assert.equal(
    policy.carryover(capped, balance({ allowance: { days: 1, carriedOverDays: 0, adjustmentDays: 0 }, booked: { approved: 3, pending: 0 } })),
    0,
    "an overdrawn year carries nothing, not a debt",
  );

  const uncapped = { ...pto, carryoverEnabled: true, carryoverMaxDays: null };
  assert.equal(policy.carryover(uncapped, withRemaining(12)), 12);

  const untracked = { ...uncapped, defaultAllowanceDays: null };
  assert.equal(policy.carryover(untracked, policy.balance({ leaveType: untracked, allowance: null, booked: nothing })), null);
});

test("days already carried into next year count as spent in the year they left, and carryover recomputes stably", () => {
  const capped = { ...pto, defaultAllowanceDays: 7, carryoverEnabled: true, carryoverMaxDays: 5 };
  const closed = (carriedOut: number, approved = 0) =>
    tracked(policy.balance({ leaveType: capped, allowance: null, booked: { approved, pending: 0 }, carriedOut }));

  assert.deepEqual([closed(0).remaining, closed(5).remaining], [7, 2], "carrying 5 out leaves 2 to book");
  assert.equal(closed(5).carriedOut, 5);
  assert.equal(closed(5).total, 7, "the total is unchanged; only what is left shrinks");
  // The carry is computed from what was left before carrying, so it is the same
  // whether or not an earlier run already carried.
  assert.equal(policy.carryover(capped, closed(0)), 5);
  assert.equal(policy.carryover(capped, closed(5)), 5);
  // Booking the uncarried 2 leaves the carry at the cap; booking more would lower it.
  assert.equal(policy.carryover(capped, closed(5, 2)), 5);
  assert.equal(policy.carryover(capped, closed(5, 3)), 4);

  const uncapped = { ...capped, carryoverMaxDays: null };
  const all = tracked(policy.balance({ leaveType: uncapped, allowance: null, booked: nothing, carriedOut: 7 }));
  assert.equal(all.remaining, 0);
  assert.equal(policy.carryover(uncapped, all), 7);
  assert.deepEqual(findShortfall([{ year: 2026, days: 0.5, before: all }]), { year: 2026, requested: 0.5, remaining: 0, yearsSpanned: 1 });
});

test("the policy splits a request over New Year by calendar year", () => {
  const calendar = { workingDays: [1, 2, 3, 4, 5], holidays: ["2027-01-01"] };
  assert.deepEqual(policy.periodsFor({ startDate: "2026-12-30", endDate: "2027-01-05", dayPortion: "full" }, calendar), [
    { year: 2026, days: 2 },
    { year: 2027, days: 2 },
  ]);
});

test("the shortfall is the first year whose balance can't cover its share; pending counts, untracked never falls short", () => {
  const two = tracked(balance({ allowance: { days: 2, carriedOverDays: 0, adjustmentDays: 0 }, booked: nothing }));
  const twoWithPending = tracked(balance({ allowance: { days: 3, carriedOverDays: 0, adjustmentDays: 0 }, booked: { approved: 0, pending: 1 } }));
  const unlimited: Balance = { tracked: false, used: 40, pending: 0 };

  assert.equal(findShortfall([{ year: 2026, days: 2, before: two }]), null, "exactly enough is enough");
  assert.deepEqual(findShortfall([{ year: 2026, days: 2.5, before: two }]), { year: 2026, requested: 2.5, remaining: 2, yearsSpanned: 1 });
  assert.deepEqual(findShortfall([{ year: 2026, days: 3, before: twoWithPending }]), { year: 2026, requested: 3, remaining: 2, yearsSpanned: 1 });
  assert.equal(findShortfall([{ year: 2026, days: 300, before: unlimited }]), null);

  // Covered in the first year, short in the second.
  assert.deepEqual(
    findShortfall([
      { year: 2026, days: 1, before: two },
      { year: 2027, days: 3, before: two },
    ]),
    { year: 2027, requested: 3, remaining: 2, yearsSpanned: 2 },
  );
});

test("assertCovered throws insufficient_balance carrying the shortfall, and passes when covered", () => {
  const two = tracked(balance({ allowance: { days: 2, carriedOverDays: 0, adjustmentDays: 0 }, booked: nothing }));
  assert.doesNotThrow(() => assertCovered([{ year: 2026, days: 2, before: two }]));
  assert.throws(
    () => assertCovered([{ year: 2026, days: 3, before: two }]),
    (err) => isDomainError(err, "insufficient_balance") && err.details !== undefined && "remaining" in err.details && err.details.remaining === 2 && err.details.requested === 3,
  );
});

test("remainingAfter is null for an untracked balance", () => {
  assert.equal(remainingAfter({ tracked: false, used: 0, pending: 0 }, 3), null);
  assert.equal(remainingAfter(tracked(balance({})), 3), 12);
});

test("policies resolve by key; an unknown key fails loudly instead of falling back", () => {
  assert.ok(resolveAllowancePolicy("annual_calendar_year") instanceof AnnualCalendarYearPolicy);
  for (const key of ["", "anniversary_year", "toString", "__proto__"]) {
    assert.throws(() => resolveAllowancePolicy(key), (err) => isDomainError(err, "policy_unavailable"), key);
  }
});

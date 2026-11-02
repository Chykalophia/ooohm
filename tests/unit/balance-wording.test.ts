import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWANCE_AUDIT_ACTIONS, BALANCE_EVENT_TYPES } from "@/domain/events";
import type { Balance } from "@/domain/allowance-policy";
import { formatBalanceTotal, formatBalanceUsage, formatRequestCost, formatShortfall } from "@/lib/format";

test("the preview says what a request costs and what it leaves", () => {
  assert.equal(
    formatRequestCost({ days: 3, years: [{ year: 2026, days: 3, remainingAfter: 12 }] }),
    "This is 3 days. You'll have 12 days left for 2026.",
  );
  assert.equal(
    formatRequestCost({ days: 0.5, years: [{ year: 2026, days: 0.5, remainingAfter: 1 }] }),
    "This is 0.5 days. You'll have 1 day left for 2026.",
  );
  assert.equal(formatRequestCost({ days: 1, years: [{ year: 2026, days: 1, remainingAfter: 0 }] }), "This is 1 day. You'll have 0 days left for 2026.");
});

test("an untracked type gets the cost only", () => {
  assert.equal(formatRequestCost({ days: 2, years: [{ year: 2026, days: 2, remainingAfter: null }] }), "This is 2 days.");
});

test("a request over New Year shows each year's share and balance", () => {
  assert.equal(
    formatRequestCost({
      days: 3,
      years: [
        { year: 2026, days: 1, remainingAfter: 4 },
        { year: 2027, days: 2, remainingAfter: 13 },
      ],
    }),
    "This is 3 days: 1 in 2026, 2 in 2027. You'll have 4 days left for 2026 and 13 days left for 2027.",
  );
});

test("a shortfall says exactly what is left, naming the year that falls short", () => {
  assert.equal(
    formatShortfall({ year: 2026, requested: 5, remaining: 2, yearsSpanned: 1 }),
    "That's 5 days, but you only have 2 days left for 2026.",
  );
  assert.equal(
    formatShortfall({ year: 2026, requested: 1, remaining: 0.5, yearsSpanned: 1 }),
    "That's 1 day, but you only have 0.5 days left for 2026.",
  );
  assert.equal(formatShortfall({ year: 2027, requested: 2, remaining: 0, yearsSpanned: 2 }), "That's 2 days in 2027, but you have no days left for 2027.");
  assert.equal(formatShortfall({ year: 2026, requested: 1, remaining: -3, yearsSpanned: 1 }), "That's 1 day, but you have no days left for 2026.");
});

test("balance event and audit names are the public contract", () => {
  assert.deepEqual(Object.values(BALANCE_EVENT_TYPES), ["balance.adjusted"]);
  // `sync` is written by inbound adapter sync.
  assert.deepEqual(ALLOWANCE_AUDIT_ACTIONS, {
    carryover: "allowance.carried_over",
    allowance_created: "allowance.created",
    admin_edit: "allowance.edited",
    sync: "allowance.synced",
  });
});

type Tracked = Extract<Balance, { tracked: true }>;
const base: Tracked = {
  tracked: true, allowance: 15, carriedOver: 0, adjustment: 0, total: 15, used: 0, pending: 0, carriedOut: 0, remaining: 15,
};

test("a balance card's total shows its parts only when it differs from the allowance, so the numbers reconcile", () => {
  assert.equal(formatBalanceTotal(base), "of 15 days");
  assert.equal(formatBalanceTotal({ ...base, adjustment: 2, total: 17 }), "of 17 days (15 + 2 adjusted)");
  assert.equal(formatBalanceTotal({ ...base, carriedOver: 3, total: 18 }), "of 18 days (15 + 3 carried over)");
  assert.equal(formatBalanceTotal({ ...base, carriedOver: 3, adjustment: -1.5, total: 16.5 }), "of 16.5 days (15 + 3 carried over - 1.5 adjusted)");
  assert.equal(formatBalanceTotal({ ...base, allowance: 1, total: 1 }), "of 1 day");
});

test("the usage line leaves out zeros and names days carried into next year", () => {
  assert.equal(formatBalanceUsage(base, 2026), "");
  assert.equal(formatBalanceUsage({ ...base, used: 2, pending: 0.5 }, 2026), "2 used · 0.5 pending");
  assert.equal(formatBalanceUsage({ ...base, used: 2, carriedOut: 5 }, 2026), "2 used · 5 carried into 2027");
  assert.equal(formatBalanceUsage({ tracked: false, used: 3, pending: 0 }, 2026), "3 used");
});

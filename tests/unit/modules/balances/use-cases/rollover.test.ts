import assert from "node:assert/strict";
import { test } from "node:test";
import { runYearRollover } from "@/modules/balances/application/use-cases/roll-over-year";
import type { AdminLeaveType } from "@/modules/balances/application/ports";
import { unwrap } from "@/shared/lib/result";
import { ANA, BO, balancesKit, type BalancesKit, leaveType, person, VACATION } from "../fakes/ports";
import { first } from "../../../../support/present";

/** Ana had 20 days of vacation in 2026 and took 15; the clock is in January 2027. */
function closingYear(type: Partial<AdminLeaveType> = {}): BalancesKit {
  const kit = balancesKit(new Date("2027-01-04T10:00:00Z"));
  kit.directory.add(person(ANA)).type(leaveType(type));
  kit.allowances.seed({ userId: ANA, leaveTypeId: VACATION, year: 2026, days: 20 });
  kit.allowances.booked.push({ userId: ANA, leaveTypeId: VACATION, year: 2026, days: 15, status: "approved" });
  return kit;
}

const next = (kit: BalancesKit) => kit.allowances.byKey({ userId: ANA, leaveTypeId: VACATION, year: 2027 });

test("running the rollover twice changes nothing the second time", async () => {
  const kit = closingYear({ carryoverEnabled: true });
  const first = unwrap(await runYearRollover(kit.deps));
  assert.deepEqual(first, { companies: 1, members: 1, carried: 1, created: 0 });
  assert.deepEqual([next(kit)?.days, next(kit)?.carriedOverDays], [20, 5]);
  const rows = JSON.stringify([...kit.allowances.rows.values()]);
  const written = { audit: kit.audit.entries.length, events: kit.outbox.events.length };

  const second = unwrap(await runYearRollover(kit.deps));
  assert.deepEqual(second, { companies: 1, members: 1, carried: 0, created: 0 });
  assert.equal(JSON.stringify([...kit.allowances.rows.values()]), rows, "no row changed");
  assert.deepEqual({ audit: kit.audit.entries.length, events: kit.outbox.events.length }, written, "nothing more was recorded");
});

test("carryover is off by default: the new year gets its default and nothing carries", async () => {
  const kit = closingYear();
  assert.equal(leaveType().carryoverEnabled, false);
  const result = unwrap(await runYearRollover(kit.deps));
  assert.deepEqual([result.carried, result.created], [0, 1]);
  assert.deepEqual([next(kit)?.days, next(kit)?.carriedOverDays], [20, 0]);
  assert.deepEqual(kit.audit.entries.map((e) => e.action), ["allowance.created"]);
  assert.deepEqual(first(kit.audit.entries).source, { kind: "system", process: "year_rollover" });
});

test("the carry is capped by carryoverMaxDays", async () => {
  const kit = closingYear({ carryoverEnabled: true, carryoverMaxDays: 3 });
  unwrap(await runYearRollover(kit.deps));
  assert.equal(next(kit)?.carriedOverDays, 3);
  assert.deepEqual(kit.outbox.types(), ["balance.adjusted"]);
  assert.equal((first(kit.outbox.events).payload as { reason: string }).reason, "carryover");
});

test("an existing next-year row takes the carry, and someone who joined after the closing year carries nothing", async () => {
  const kit = closingYear({ carryoverEnabled: true });
  kit.allowances.seed({ userId: ANA, leaveTypeId: VACATION, year: 2027, days: 22 });
  kit.directory.add(person(BO, { createdAt: new Date("2027-01-02T00:00:00Z") }));
  kit.allowances.seed({ userId: BO, leaveTypeId: VACATION, year: 2026, days: 20 });
  const result = unwrap(await runYearRollover(kit.deps));
  assert.deepEqual([next(kit)?.days, next(kit)?.carriedOverDays], [22, 5]);
  assert.equal(kit.allowances.byKey({ userId: BO, leaveTypeId: VACATION, year: 2027 })?.carriedOverDays, 0);
  assert.deepEqual(result, { companies: 1, members: 2, carried: 1, created: 1 });
  assert.equal(kit.units.run, 2, "one unit of work per member");
});

test("a year that has not ended is invalid_input, before any change", async () => {
  const kit = closingYear({ carryoverEnabled: true });
  const r = await runYearRollover(kit.deps, 2027);
  assert.ok(!r.ok && r.error.code === "invalid_input");
  assert.equal(kit.units.run, 0);
});

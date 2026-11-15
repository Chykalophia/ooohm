import assert from "node:assert/strict";
import { test } from "node:test";
import { removeAllowanceRule } from "@/modules/balances/application/use-cases/remove-allowance-rule";
import { setAllowanceRule } from "@/modules/balances/application/use-cases/set-allowance-rule";
import { unwrap } from "@/shared/lib/result";
import { ANA, actorFor, BO, BOSS, balancesKit, type BalancesKit, DEV, person, VACATION } from "../fakes/ports";

/** Ana is in Dev on the default 20 days; Bo is in Dev with 30 set by hand. */
function company(): BalancesKit {
  const kit = balancesKit(new Date("2026-06-01T10:00:00Z"));
  kit.directory.add(person(ANA, { departmentId: DEV }), person(BO, { departmentId: DEV }), person(BOSS, { role: "admin" }));
  kit.allowances.seed({ userId: ANA, leaveTypeId: VACATION, year: 2026, days: 20 });
  kit.allowances.seed({ userId: ANA, leaveTypeId: VACATION, year: 2025, days: 20 });
  kit.allowances.seed({ userId: BO, leaveTypeId: VACATION, year: 2026, days: 30 });
  return kit;
}
const boss = (kit: BalancesKit) => actorFor(kit.directory.people.get(BOSS)!);
const days = (kit: BalancesKit, userId: string, year: number) => kit.allowances.byKey({ userId, leaveTypeId: VACATION, year })?.days;

test("a rule moves this year's rows that followed the default, and leaves hand-set rows and closed years alone", async () => {
  const kit = company();
  const rule = unwrap(await setAllowanceRule(kit.deps, boss(kit), { leaveTypeId: VACATION, departmentId: DEV, levelId: null, days: 24 }));
  assert.equal(rule.allowancesUpdated, 1);
  assert.deepEqual([days(kit, ANA, 2026), days(kit, ANA, 2025), days(kit, BO, 2026)], [24, 20, 30]);
  assert.deepEqual(kit.outbox.types(), ["allowance_rule.set", "balance.adjusted"]);
  assert.equal(kit.directory.locks[0], `company:${kit.directory.company_.id}`, "the company lock comes first");

  const removed = unwrap(await removeAllowanceRule(kit.deps, boss(kit), rule.id));
  assert.equal(removed.allowancesUpdated, 1);
  assert.equal(days(kit, ANA, 2026), 20, "back to the type's default");
  assert.equal(kit.rules.rules.length, 0);
});

test("the same days again change nothing; a rule with no target is invalid_input; an unknown department is not_found", async () => {
  const kit = company();
  const input = { leaveTypeId: VACATION, departmentId: DEV, levelId: null, days: 24 };
  unwrap(await setAllowanceRule(kit.deps, boss(kit), input));
  const events = kit.outbox.events.length;
  assert.equal(unwrap(await setAllowanceRule(kit.deps, boss(kit), input)).allowancesUpdated, 0);
  assert.equal(kit.outbox.events.length, events);
  const noTarget = await setAllowanceRule(kit.deps, boss(kit), { ...input, departmentId: null });
  assert.ok(!noTarget.ok && noTarget.error.code === "invalid_input");
  const unknown = await setAllowanceRule(kit.deps, boss(kit), { ...input, departmentId: "00000000-0000-4000-8000-00000000dead" });
  assert.ok(!unknown.ok && unknown.error.code === "not_found");
  assert.equal(kit.units.rolledBack, 1);
});

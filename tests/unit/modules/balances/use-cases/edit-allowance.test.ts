import assert from "node:assert/strict";
import { test } from "node:test";
import { setAllowanceOverride } from "@/modules/balances/application/use-cases/set-allowance-override";
import { unwrap } from "@/shared/lib/result";
import { ANA, actorFor, BOSS, balancesKit, type BalancesKit, leaveType, person, VACATION } from "../fakes/ports";
import { first } from "../../../../support/present";

function company(type = leaveType()): BalancesKit {
  const kit = balancesKit(new Date("2026-06-01T10:00:00Z"));
  kit.directory.add(person(ANA), person(BOSS, { role: "admin" })).type(type);
  return kit;
}
const boss = (kit: BalancesKit) => actorFor(kit.directory.people.get(BOSS)!);
const edit = { userId: ANA, leaveTypeId: VACATION, year: 2026, days: 22, adjustmentDays: 1.5, reason: "  Agreed at hiring " };

test("an edit writes an audit row with the admin's reason, and balance.adjusted without it", async () => {
  const kit = company();
  const { row, changed } = unwrap(await setAllowanceOverride(kit.deps, boss(kit), edit));
  assert.equal(changed, true);
  assert.deepEqual([row.days, row.adjustmentDays, row.carriedOverDays], [22, 1.5, 0]);

  assert.equal(kit.audit.entries.length, 1);
  const audit = first(kit.audit.entries);
  assert.equal(audit.action, "allowance.edited");
  assert.equal(audit.subjectUserId, ANA);
  assert.deepEqual(audit.source, { kind: "user", userId: BOSS });
  assert.equal(audit.before, null);
  assert.equal((audit.after as { reason?: string }).reason, "Agreed at hiring", "the reason, trimmed, in the audit row");

  assert.deepEqual(kit.outbox.types(), ["balance.adjusted"]);
  const payload = first(kit.outbox.events).payload as Record<string, unknown>;
  assert.equal(payload.reason, "admin_edit");
  assert.ok(!JSON.stringify(payload).includes("Agreed at hiring"), "free text about a person never goes to other systems");
  assert.deepEqual([payload.days, payload.adjustmentDays, payload.carriedOverDays], [22, 1.5, 0]);
  assert.deepEqual(kit.directory.locks, [`member:${ANA}`], "under the member lock, as submit and the rollover take it");
});

test("the same amounts again write and record nothing", async () => {
  const kit = company();
  unwrap(await setAllowanceOverride(kit.deps, boss(kit), edit));
  const again = unwrap(await setAllowanceOverride(kit.deps, boss(kit), { ...edit, reason: "Again" }));
  assert.equal(again.changed, false);
  assert.equal(kit.audit.entries.length, 1);
  assert.equal(kit.outbox.events.length, 1);
});

test("editing last year re-carries into this year at once, attributed to the admin", async () => {
  const kit = company(leaveType({ carryoverEnabled: true }));
  kit.clock.set(new Date("2027-01-10T10:00:00Z"));
  kit.allowances.seed({ userId: ANA, leaveTypeId: VACATION, year: 2027, days: 20 });
  unwrap(await setAllowanceOverride(kit.deps, boss(kit), { ...edit, days: 25, adjustmentDays: 0 }));
  assert.equal(kit.allowances.byKey({ userId: ANA, leaveTypeId: VACATION, year: 2027 })?.carriedOverDays, 25);
  assert.deepEqual(kit.audit.entries.map((e) => e.action), ["allowance.edited", "allowance.carried_over"]);
  assert.ok(kit.audit.entries.every((e) => e.source.kind === "user"));
});

test("a non-admin is forbidden; no reason, or a year before last, is invalid_input; nothing is written", async () => {
  const kit = company();
  const ana = actorFor(kit.directory.people.get(ANA)!);
  const notAdmin = await setAllowanceOverride(kit.deps, ana, edit);
  assert.ok(!notAdmin.ok && notAdmin.error.code === "forbidden");
  const noReason = await setAllowanceOverride(kit.deps, boss(kit), { ...edit, reason: "  " });
  assert.ok(!noReason.ok && noReason.error.code === "invalid_input");
  const closed = await setAllowanceOverride(kit.deps, boss(kit), { ...edit, year: 2024 });
  assert.ok(!closed.ok && closed.error.code === "invalid_input");
  assert.equal(kit.allowances.rows.size, 0);
  assert.equal(kit.audit.entries.length, 0);
});

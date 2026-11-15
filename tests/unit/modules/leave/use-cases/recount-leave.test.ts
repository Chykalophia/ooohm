import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTHING_RECOUNTED, recountLeave } from "@/modules/leave/application/use-cases/recount-leave";
import { addLeaveFor } from "@/modules/leave/application/use-cases/add-leave-for";
import { unwrap } from "@/shared/lib/result";
import { actorFor, ANA, BOSS, type LeaveKit, leaveKit, person, VACATION } from "../fakes/ports";

const draft = { leaveTypeId: VACATION, startDate: "2026-11-09", endDate: "2026-11-10", dayPortion: "full" as const, note: null };

function booked(): { kit: LeaveKit; id: Promise<string> } {
  const kit = leaveKit();
  kit.directory.add(person(ANA, "Ana"), person(BOSS, "Boss", { role: "admin" }));
  return { kit, id: addLeaveFor(kit.deps, actorFor(kit.directory.people.get(BOSS)!), ANA, draft).then((r) => unwrap(r).id) };
}
const boss = (kit: LeaveKit) => actorFor(kit.directory.people.get(BOSS)!);

test("a new holiday on booked leave takes a day off its count, recorded as the admin's through the holiday change", async () => {
  const { kit, id: pending } = booked();
  const id = await pending;
  kit.sent.length = 0;
  kit.directory.holidays = ["2026-11-10"];
  const r = await recountLeave(kit.deps, kit.deps.read, boss(kit), { kind: "holidays", added: [{ date: "2026-11-10", name: "Founders' Day" }], removed: [] });
  assert.ok(r.ok);
  assert.deepEqual(r.value.outcome, { recounted: 1, nowFree: 0, overdrawn: [] });
  assert.equal(kit.requests.rows.get(id)?.days, 1);
  assert.deepEqual(kit.requests.yearDays.get(id), [{ year: 2026, days: 1 }]);
  assert.equal(kit.outbox.types().at(-1), "leave.recounted");
  assert.deepEqual(kit.audit.entries.at(-1)?.source, { kind: "user", userId: BOSS, via: "holiday_change" });
  assert.deepEqual(
    r.value.notify.map((m) => [m.type, m.to]),
    [["leave.recounted", "ana@example.test"]],
  );
  const mail = r.value.notify[0] as Extract<(typeof r.value.notify)[number], { type: "leave.recounted" }>;
  assert.equal(mail.data.previousDays, 2);
});

test("a holiday nobody's leave touches, or one in a closed year, recounts nothing", async () => {
  const { kit, id } = booked();
  await id;
  const events = kit.outbox.events.length;
  const elsewhere = await recountLeave(kit.deps, kit.deps.read, boss(kit), { kind: "holidays", added: [{ date: "2026-11-20", name: "Other" }], removed: [] });
  assert.deepEqual(unwrap(elsewhere).outcome, NOTHING_RECOUNTED);
  const closed = await recountLeave(kit.deps, kit.deps.read, boss(kit), { kind: "holidays", added: [], removed: [{ date: "2025-11-10", name: "Old" }] });
  assert.deepEqual(unwrap(closed).outcome, NOTHING_RECOUNTED);
  assert.equal(kit.outbox.events.length, events);
});

test("a new working day that overdraws a balance is named for the admin and in the person's email", async () => {
  const { kit, id: pending } = booked();
  const id = await pending;
  const r0 = kit.requests.rows.get(id)!;
  kit.requests.rows.set(id, { ...r0, endDate: "2026-11-14" });
  kit.requests.yearDays.set(id, [{ year: 2026, days: 5 }]);
  kit.directory.settings = { ...kit.directory.settings, workingDays: [1, 2, 3, 4, 5, 6] };
  kit.allowances.remaining.set(2026, -1);
  const r = await recountLeave(kit.deps, kit.deps.read, boss(kit), { kind: "working_days", previous: [1, 2, 3, 4, 5] });
  assert.ok(r.ok);
  assert.deepEqual(r.value.outcome.overdrawn, [{ userId: ANA, leaveTypeId: VACATION, personName: "Ana", leaveTypeName: "Vacation", year: 2026, over: 1 }]);
  assert.equal(kit.requests.rows.get(id)?.days, 6);
  const mail = r.value.notify[0] as Extract<(typeof r.value.notify)[number], { type: "leave.recounted" }>;
  assert.equal(mail.data.overdrawn, "1 day over your Vacation balance for 2026");
});

test("an unknown company is no_company", async () => {
  const { kit } = booked();
  const r = await recountLeave(kit.deps, kit.deps.read, { ...boss(kit), companyId: "00000000-0000-4000-8000-00000000c002" }, { kind: "working_days", previous: [1, 2, 3, 4, 5] });
  assert.ok(!r.ok && r.error.code === "no_company");
});

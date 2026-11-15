import assert from "node:assert/strict";
import { test } from "node:test";
import { addLeaveFor } from "@/modules/leave/application/use-cases/add-leave-for";
import { actorFor, ANA, BOSS, COMPANY, CY, type LeaveKit, leaveKit, MO, person, VACATION } from "../fakes/ports";

const draft = { leaveTypeId: VACATION, startDate: "2026-11-09", endDate: "2026-11-10", dayPortion: "full" as const, note: "Called in sick" };

function team(): LeaveKit {
  const kit = leaveKit();
  kit.directory.add(person(MO, "Mo", { role: "manager" }), person(ANA, "Ana", { managerId: MO }), person(CY, "Cy"), person(BOSS, "Boss", { role: "admin" }));
  return kit;
}
const as = (kit: LeaveKit, id: string) => actorFor(kit.directory.people.get(id)!);

test("a manager adds approved leave for their report: requested then approved, both theirs, and the person is emailed", async () => {
  const kit = team();
  const r = await addLeaveFor(kit.deps, as(kit, MO), ANA, draft);
  assert.ok(r.ok);
  assert.equal(r.value.userId, ANA);
  assert.equal(r.value.status, "approved");
  assert.equal(r.value.approverId, MO);
  assert.equal(r.value.personName, "Ana");
  assert.equal(r.value.note, "Called in sick");
  assert.deepEqual(kit.outbox.types(), ["leave.requested", "leave.approved"]);
  assert.deepEqual(
    kit.audit.entries.map((e) => e.source),
    [
      { kind: "user", userId: MO },
      { kind: "user", userId: MO },
    ],
  );
  assert.deepEqual(kit.directory.locks, [`company:${COMPANY}`, `member:${ANA}`]);
  assert.deepEqual(
    kit.sent.map((m) => [m.type, m.to]),
    [["leave.added", "ana@example.test"]],
  );
  const mail = kit.sent[0] as Extract<(typeof kit.sent)[number], { type: "leave.added" }>;
  assert.equal(mail.data.addedByName, "Mo");
});

test("not their manager is forbidden; nobody active by that id is not_found", async () => {
  const kit = team();
  const stranger = await addLeaveFor(kit.deps, as(kit, CY), ANA, draft);
  assert.ok(!stranger.ok && stranger.error.code === "forbidden");
  const self = await addLeaveFor(kit.deps, as(kit, ANA), ANA, draft);
  assert.ok(!self.ok && self.error.code === "forbidden");
  const nobody = await addLeaveFor(kit.deps, as(kit, BOSS), "00000000-0000-4000-8000-00000000ffff", draft);
  assert.ok(!nobody.ok && nobody.error.code === "not_found");
  kit.directory.people.set(ANA, { ...kit.directory.people.get(ANA)!, isActive: false });
  const inactive = await addLeaveFor(kit.deps, as(kit, BOSS), ANA, draft);
  assert.ok(!inactive.ok && inactive.error.code === "not_found");
  assert.equal(kit.requests.rows.size, 0);
});

test("a shortfall names the person for an admin, and hides the numbers from a manager who may not see balances", async () => {
  const kit = team();
  kit.allowances.remaining.set(2026, 1);
  const admin = await addLeaveFor(kit.deps, as(kit, BOSS), ANA, draft);
  assert.ok(!admin.ok && admin.error.code === "insufficient_balance");
  assert.deepEqual(admin.error.details, { year: 2026, requested: 2, remaining: 1, yearsSpanned: 1, person: "Ana" });
  kit.directory.managersSeeDetails = false;
  const manager = await addLeaveFor(kit.deps, as(kit, MO), ANA, draft);
  assert.ok(!manager.ok && manager.error.code === "insufficient_balance");
  assert.equal(manager.error.details, undefined);
});

test("it overlaps the person's own requests like their own submit", async () => {
  const kit = team();
  assert.ok((await addLeaveFor(kit.deps, as(kit, MO), ANA, draft)).ok);
  const again = await addLeaveFor(kit.deps, as(kit, BOSS), ANA, { ...draft, startDate: "2026-11-10", endDate: "2026-11-10" });
  assert.ok(!again.ok && again.error.code === "overlapping_request");
});

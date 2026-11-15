import assert from "node:assert/strict";
import { test } from "node:test";
import { addLeaveFor } from "@/modules/leave/application/use-cases/add-leave-for";
import { removeLeaveFor } from "@/modules/leave/application/use-cases/remove-leave-for";
import { submitLeaveRequest } from "@/modules/leave/application/use-cases/submit-leave-request";
import { unwrap } from "@/shared/lib/result";
import { actorFor, ANA, BOSS, CY, type LeaveKit, leaveKit, MO, person, VACATION } from "../fakes/ports";

const draft = { leaveTypeId: VACATION, startDate: "2026-11-09", endDate: "2026-11-10", dayPortion: "full" as const, note: null };

function team(now?: Date): LeaveKit {
  const kit = leaveKit(now);
  kit.directory.add(person(MO, "Mo", { role: "manager" }), person(ANA, "Ana", { managerId: MO }), person(CY, "Cy"), person(BOSS, "Boss", { role: "admin" }));
  return kit;
}
const as = (kit: LeaveKit, id: string) => actorFor(kit.directory.people.get(id)!);

test("a manager removes their report's approved leave, past leave included, with the reason kept and the person emailed", async () => {
  const kit = team();
  const { id } = unwrap(await addLeaveFor(kit.deps, as(kit, MO), ANA, draft));
  kit.sent.length = 0;
  kit.clock.set(new Date("2026-11-20T09:00:00Z"));
  const r = await removeLeaveFor(kit.deps, as(kit, MO), id, "  Worked those days ");
  assert.ok(r.ok);
  assert.equal(r.value.status, "cancelled");
  assert.equal(r.value.decisionNote, "Worked those days");
  assert.deepEqual(kit.outbox.types(), ["leave.requested", "leave.approved", "leave.cancelled"]);
  assert.deepEqual(kit.audit.entries.at(-1)?.source, { kind: "user", userId: MO });
  assert.deepEqual(
    kit.sent.map((m) => [m.type, m.to]),
    [["leave.removed", "ana@example.test"]],
  );
  const mail = kit.sent[0] as Extract<(typeof kit.sent)[number], { type: "leave.removed" }>;
  assert.equal(mail.data.reason, "Worked those days");
  assert.equal(mail.data.removedByName, "Mo");
  assert.deepEqual(kit.allowances.recarried, [], "this year's leave re-carries nothing");
});

test("no reason is invalid_input; someone else's report is forbidden; pending leave is invalid_transition", async () => {
  const kit = team();
  const pending = unwrap(await submitLeaveRequest(kit.deps, as(kit, ANA), draft));
  const blank = await removeLeaveFor(kit.deps, as(kit, MO), pending.id, "   ");
  assert.ok(!blank.ok && blank.error.code === "invalid_input");
  const stranger = await removeLeaveFor(kit.deps, as(kit, CY), pending.id, "typo");
  assert.ok(!stranger.ok && stranger.error.code === "forbidden");
  const notApproved = await removeLeaveFor(kit.deps, as(kit, MO), pending.id, "typo");
  assert.ok(!notApproved.ok && notApproved.error.code === "invalid_transition");
  const unknown = await removeLeaveFor(kit.deps, as(kit, BOSS), "00000000-0000-4000-8000-00000000ffff", "typo");
  assert.ok(!unknown.ok && unknown.error.code === "not_found");
  assert.equal(kit.requests.rows.get(pending.id)?.status, "pending");
});

test("leave that began last year re-carries last year's days at once", async () => {
  const kit = team(new Date("2026-12-28T10:00:00Z"));
  const { id } = unwrap(await addLeaveFor(kit.deps, as(kit, BOSS), ANA, { ...draft, startDate: "2026-12-31", endDate: "2027-01-04" }));
  kit.clock.set(new Date("2027-01-05T10:00:00Z"));
  assert.ok((await removeLeaveFor(kit.deps, as(kit, BOSS), id, "Entered twice")).ok);
  assert.equal(kit.allowances.recarried.length, 1);
  assert.equal((kit.allowances.recarried[0] as { closingYear: number }).closingYear, 2026);
});

test("leave of a closed year is past_year_closed", async () => {
  const kit = team(new Date("2026-12-01T10:00:00Z"));
  const { id } = unwrap(await addLeaveFor(kit.deps, as(kit, BOSS), ANA, { ...draft, startDate: "2026-12-07", endDate: "2026-12-08" }));
  kit.clock.set(new Date("2027-01-05T10:00:00Z"));
  const r = await removeLeaveFor(kit.deps, as(kit, BOSS), id, "late");
  assert.ok(!r.ok && r.error.code === "past_year_closed");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelLeaveRequest } from "@/modules/leave/application/use-cases/cancel-leave-request";
import { submitLeaveRequest } from "@/modules/leave/application/use-cases/submit-leave-request";
import { unwrap } from "@/shared/lib/result";
import { actorFor, ANA, CY, type LeaveKit, leaveKit, MO, person, VACATION } from "../fakes/ports";

const draft = { leaveTypeId: VACATION, startDate: "2026-11-09", endDate: "2026-11-10", dayPortion: "full" as const, note: null };

function team(): LeaveKit {
  const kit = leaveKit();
  kit.directory.add(person(MO, "Mo", { role: "manager" }), person(ANA, "Ana", { managerId: MO }), person(CY, "Cy"));
  return kit;
}
const as = (kit: LeaveKit, id: string) => actorFor(kit.directory.people.get(id)!);
const submitted = async (kit: LeaveKit) => unwrap(await submitLeaveRequest(kit.deps, as(kit, ANA), draft));

test("cancelling a pending request records one cancelled change and emails the requester and the approver", async () => {
  const kit = team();
  const { id } = await submitted(kit);
  kit.sent.length = 0;
  const r = await cancelLeaveRequest(kit.deps, as(kit, ANA), id);
  assert.ok(r.ok);
  assert.equal(r.value.status, "cancelled");
  assert.deepEqual(kit.outbox.types(), ["leave.requested", "leave.cancelled"]);
  const audit = kit.audit.entries.at(-1)!;
  assert.equal(audit.action, "leave_request.cancelled");
  assert.equal((audit.before as { status: string }).status, "pending");
  assert.deepEqual(
    kit.sent.map((m) => [m.type, m.to]),
    [
      ["leave.cancelled_requester", "ana@example.test"],
      ["leave.cancelled_approver", "mo@example.test"],
    ],
  );
});

test("someone else's request is forbidden, an unknown one not_found, and a second cancel invalid_transition", async () => {
  const kit = team();
  const { id } = await submitted(kit);
  const theirs = await cancelLeaveRequest(kit.deps, as(kit, CY), id);
  assert.ok(!theirs.ok && theirs.error.code === "forbidden");
  const unknown = await cancelLeaveRequest(kit.deps, as(kit, ANA), "00000000-0000-4000-8000-00000000ffff");
  assert.ok(!unknown.ok && unknown.error.code === "not_found");
  const malformed = await cancelLeaveRequest(kit.deps, as(kit, ANA), "nope");
  assert.ok(!malformed.ok && malformed.error.code === "not_found");
  assert.ok((await cancelLeaveRequest(kit.deps, as(kit, ANA), id)).ok);
  const again = await cancelLeaveRequest(kit.deps, as(kit, ANA), id);
  assert.ok(!again.ok && again.error.code === "invalid_transition");
  assert.deepEqual(kit.outbox.types(), ["leave.requested", "leave.cancelled"]);
});

test("approved leave that is over is leave_taken, and nothing is written", async () => {
  const kit = team();
  kit.directory.people.set(ANA, { ...kit.directory.people.get(ANA)!, canSelfApprove: true });
  const { id } = await submitted(kit);
  kit.clock.set(new Date("2026-11-12T09:00:00Z"));
  const r = await cancelLeaveRequest(kit.deps, as(kit, ANA), id);
  assert.ok(!r.ok && r.error.code === "leave_taken");
  assert.equal(kit.requests.rows.get(id)?.status, "approved");
  assert.equal(kit.units.rolledBack, 1);
});

test("a self-approved cancel does not email the canceller as approver; with approval off, whoever was told hears it", async () => {
  const kit = team();
  kit.directory.people.set(ANA, { ...kit.directory.people.get(ANA)!, canSelfApprove: true });
  const own = await submitted(kit);
  kit.sent.length = 0;
  assert.ok((await cancelLeaveRequest(kit.deps, as(kit, ANA), own.id)).ok);
  assert.deepEqual(
    kit.sent.map((m) => m.type),
    ["leave.cancelled_requester"],
  );

  const headsUp = team();
  headsUp.directory.settings = { ...headsUp.directory.settings, approvalMode: "heads_up" };
  const booked = await submitted(headsUp);
  headsUp.sent.length = 0;
  assert.ok((await cancelLeaveRequest(headsUp.deps, as(headsUp, ANA), booked.id)).ok);
  assert.deepEqual(
    headsUp.sent.map((m) => [m.type, m.to]),
    [
      ["leave.cancelled_requester", "ana@example.test"],
      ["leave.cancelled_approver", "mo@example.test"],
    ],
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, toActor } from "@/domain/actor";
import { byUser } from "@/domain/change-source";
import { canAddLeaveFor, canCancel, canDecide, canSeeLeaveDetails, decidesByAssignment, type RequestOwnership } from "@/domain/leave-permissions";

const actor = (id: string, role: Actor["role"], companyId = "c1"): Actor => ({ id, companyId, role, canSelfApprove: false, source: byUser(id) });
const request = (over: Partial<RequestOwnership> = {}): RequestOwnership => ({
  companyId: "c1",
  userId: "emp",
  approverId: "mgr",
  ...over,
});

test("the assigned approver may decide while the rule still picks them; an unrelated employee or manager may not", () => {
  assert.equal(canDecide(actor("mgr", "manager"), request(), "mgr"), true);
  assert.equal(canDecide(actor("mgr", "employee"), request(), "mgr"), true);
  assert.equal(canDecide(actor("other", "manager"), request(), "mgr"), false);
  assert.equal(canDecide(actor("other", "employee"), request(), "other"), false, "the rule alone grants nothing without the assignment");
});

test("a stale assignment grants nothing: the rule now picks someone else, or nobody", () => {
  // e.g. a submit raced a demotion or a manager change, and nothing re-routed it.
  assert.equal(canDecide(actor("mgr", "manager"), request(), "adm"), false);
  assert.equal(canDecide(actor("mgr", "employee"), request(), null), false);
  // Admins decide whatever the assignment says.
  assert.equal(canDecide(actor("adm", "admin"), request(), null), true);
});

test("only a non-admin, or an admin's own request, rests on the assignment", () => {
  assert.equal(decidesByAssignment(actor("mgr", "manager"), request()), true);
  assert.equal(decidesByAssignment(actor("mgr", "employee"), request()), true);
  assert.equal(decidesByAssignment(actor("adm", "admin"), request()), false);
  assert.equal(decidesByAssignment(actor("emp", "admin"), request({ approverId: "emp" })), true);
});

test("any admin of the company may decide, but not across companies", () => {
  assert.equal(canDecide(actor("adm", "admin"), request(), null), true);
  assert.equal(canDecide(actor("adm", "admin", "c2"), request(), null), false);
  assert.equal(canDecide(actor("mgr", "manager", "c2"), request(), "mgr"), false);
});

test("nobody decides their own request unless they are its assigned approver", () => {
  assert.equal(canDecide(actor("emp", "admin"), request(), "mgr"), false);
  assert.equal(canDecide(actor("emp", "manager"), request({ approverId: "mgr" }), "mgr"), false);
  assert.equal(canDecide(actor("emp", "admin"), request({ approverId: "emp" }), "emp"), true);
});

test("a request routed to its requester as sole admin is theirs only while they stay an admin and the rule still picks them", () => {
  const routedToSelf = request({ approverId: "emp" });
  assert.equal(canDecide(actor("emp", "admin"), routedToSelf, "emp"), true);
  assert.equal(canDecide(actor("emp", "manager"), routedToSelf, "emp"), false);
  assert.equal(canDecide(actor("emp", "employee"), routedToSelf, "emp"), false);
  // A second admin arrived, or they now have a manager: the self-routing no longer holds.
  assert.equal(canDecide(actor("emp", "admin"), routedToSelf, "adm2"), false);
  assert.equal(canDecide(actor("emp", "admin"), routedToSelf, "mgr"), false);
  // Another admin can still decide it, so it is never stranded.
  assert.equal(canDecide(actor("adm", "admin"), routedToSelf, null), true);
});

test("only the requester may cancel", () => {
  assert.equal(canCancel(actor("emp", "employee"), request()), true);
  assert.equal(canCancel(actor("mgr", "manager"), request()), false);
  assert.equal(canCancel(actor("adm", "admin"), request()), false);
  assert.equal(canCancel(actor("emp", "employee", "c2"), request()), false);
});

test("an actor needs a company; unknown roles degrade to employee; a session actor acts as themself", () => {
  assert.equal(toActor({ id: "u", companyId: null, role: "admin" }), null);
  assert.deepEqual(toActor({ id: "u", companyId: "c1", role: "admin", canSelfApprove: true }), {
    id: "u",
    companyId: "c1",
    role: "admin",
    canSelfApprove: true,
    source: { kind: "user", userId: "u" },
  });
  assert.deepEqual(toActor({ id: "u", companyId: "c1", role: "owner" }), {
    id: "u",
    companyId: "c1",
    role: "employee",
    canSelfApprove: false,
    source: { kind: "user", userId: "u" },
  });
});

test("time off can be added for someone by an admin of their company or their direct manager, never for oneself", () => {
  const ana = { id: "ana", companyId: "c1", managerId: "mgr", departmentManagerId: null };
  assert.equal(canAddLeaveFor(actor("mgr", "manager"), ana), true);
  assert.equal(canAddLeaveFor(actor("mgr", "employee"), ana), true, "managing someone is the reporting line, not the role");
  assert.equal(canAddLeaveFor(actor("boss", "admin"), ana), true);
  assert.equal(canAddLeaveFor(actor("other", "manager"), ana), false);
  assert.equal(canAddLeaveFor(actor("ana", "admin"), ana), false);
  assert.equal(canAddLeaveFor(actor("boss", "admin", "c2"), ana), false);
});

test("a department's manager counts as a manager for its people: details while the company allows, and adding time off", () => {
  const ana = { id: "ana", companyId: "c1", managerId: "mgr", departmentManagerId: "head" };
  assert.equal(canAddLeaveFor(actor("head", "employee"), ana), true);
  assert.equal(canSeeLeaveDetails(actor("head", "manager"), ana, true), true);
  assert.equal(canSeeLeaveDetails(actor("head", "manager"), ana, false), false, "the company keeps details from managers");
  assert.equal(canSeeLeaveDetails(actor("mgr", "manager"), ana, true), true);
  assert.equal(canSeeLeaveDetails(actor("other", "manager"), ana, true), false);
  assert.equal(canAddLeaveFor(actor("ana", "employee"), { ...ana, departmentManagerId: "ana" }), false, "never for oneself");
});

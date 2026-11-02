import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, toActor } from "@/domain/actor";
import { canCancel, canDecide, decidesByAssignment, type RequestOwnership } from "@/domain/leave-permissions";

const actor = (id: string, role: Actor["role"], companyId = "c1"): Actor => ({ id, companyId, role, canSelfApprove: false });
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

test("an actor needs a company; unknown roles degrade to employee", () => {
  assert.equal(toActor({ id: "u", companyId: null, role: "admin" }), null);
  assert.deepEqual(toActor({ id: "u", companyId: "c1", role: "admin", canSelfApprove: true }), {
    id: "u",
    companyId: "c1",
    role: "admin",
    canSelfApprove: true,
  });
  assert.deepEqual(toActor({ id: "u", companyId: "c1", role: "owner" }), {
    id: "u",
    companyId: "c1",
    role: "employee",
    canSelfApprove: false,
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { type Actor, toActor } from "@/domain/actor";
import { canCancel, canDecide, type RequestOwnership } from "@/domain/leave-permissions";

const actor = (id: string, role: Actor["role"], companyId = "c1"): Actor => ({ id, companyId, role, canSelfApprove: false });
const request = (over: Partial<RequestOwnership> = {}): RequestOwnership => ({
  companyId: "c1",
  userId: "emp",
  approverId: "mgr",
  ...over,
});

test("the assigned approver may decide; an unrelated employee or manager may not", () => {
  assert.equal(canDecide(actor("mgr", "manager"), request()), true);
  assert.equal(canDecide(actor("mgr", "employee"), request()), true);
  assert.equal(canDecide(actor("other", "manager"), request()), false);
  assert.equal(canDecide(actor("other", "employee"), request()), false);
});

test("any admin of the company may decide, but not across companies", () => {
  assert.equal(canDecide(actor("adm", "admin"), request()), true);
  assert.equal(canDecide(actor("adm", "admin", "c2"), request()), false);
  assert.equal(canDecide(actor("mgr", "manager", "c2"), request()), false);
});

test("nobody decides their own request unless they are its assigned approver", () => {
  assert.equal(canDecide(actor("emp", "admin"), request()), false);
  assert.equal(canDecide(actor("emp", "manager"), request({ approverId: "mgr" })), false);
  assert.equal(canDecide(actor("emp", "admin"), request({ approverId: "emp" })), true);
});

test("a request routed to its requester as sole admin is theirs to decide only while they stay an admin", () => {
  const routedToSelf = request({ approverId: "emp" });
  assert.equal(canDecide(actor("emp", "admin"), routedToSelf), true);
  assert.equal(canDecide(actor("emp", "manager"), routedToSelf), false);
  assert.equal(canDecide(actor("emp", "employee"), routedToSelf), false);
  // Another admin can still decide it, so demotion never strands the request.
  assert.equal(canDecide(actor("adm", "admin"), routedToSelf), true);
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

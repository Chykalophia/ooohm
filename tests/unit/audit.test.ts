import assert from "node:assert/strict";
import { test } from "node:test";
import { auditActionLabel, auditFieldLabel, describeAuditChange, diffAuditSnapshots, isAuditAction } from "@/domain/audit";
import { ADMIN_EVENT_TYPES, ALLOWANCE_AUDIT_ACTIONS, CALENDAR_FEED_EVENT_TYPES, leaveAuditAction } from "@/domain/events";

const names = {
  person: (id: string) => ({ u1: "Ana", u2: "Ben" })[id],
  department: (id: string) => ({ d1: "Ops" })[id],
  leaveType: (id: string) => ({ t1: "PTO" })[id],
};

test("every action the app writes has a label", () => {
  const written = [
    ...["requested", "approved", "rejected", "cancelled", "reassigned"].map((e) => leaveAuditAction(e as "requested")),
    ...Object.values(ALLOWANCE_AUDIT_ACTIONS),
    ...Object.values(CALENDAR_FEED_EVENT_TYPES),
    ...Object.values(ADMIN_EVENT_TYPES),
  ];
  for (const action of written) {
    assert.ok(isAuditAction(action), action);
    assert.notEqual(auditActionLabel(action), action, action);
  }
  assert.equal(auditActionLabel("something.new"), "something.new", "an unknown action reads as itself");
  assert.equal(isAuditAction("something.new"), false);
});

test("admin event names are a public contract", () => {
  assert.deepEqual(Object.values(ADMIN_EVENT_TYPES), [
    "user.created",
    "user.updated",
    "user.deactivated",
    "user.reactivated",
    "user.invite_resent",
    "department.created",
    "department.renamed",
    "department.deleted",
    "leave_type.created",
    "leave_type.updated",
    "leave_type.archived",
    "leave_type.unarchived",
    "leave_type.reordered",
    "holiday.created",
    "holiday.renamed",
    "holiday.deleted",
    "company.updated",
  ]);
});

test("a change lists only the fields that differ; a creation or deletion lists the fields with values", () => {
  assert.deepEqual(diffAuditSnapshots({ role: "employee", name: "Ana" }, { role: "admin", name: "Ana" }), [
    { field: "role", before: "employee", after: "admin" },
  ]);
  assert.deepEqual(diffAuditSnapshots(null, { name: "Ops", managerId: null }), [{ field: "name", after: "Ops" }]);
  assert.deepEqual(diffAuditSnapshots({ name: "Ops" }, null), [{ field: "name", before: "Ops" }]);
  assert.deepEqual(diffAuditSnapshots({ workingDays: [1, 2] }, { workingDays: [1, 2] }), [], "arrays compare by value");
  assert.deepEqual(diffAuditSnapshots(null, null), []);
});

test("changes read in words, with ids named and unknown ids described, never shown raw", () => {
  assert.deepEqual(
    describeAuditChange(
      { managerId: "u1", departmentId: null, canSelfApprove: false, workingDays: [1, 2, 3, 4, 5] },
      { managerId: "u2", departmentId: "d1", canSelfApprove: true, workingDays: [1, 2, 3, 4] },
      names,
    ),
    ["Manager: Ana → Ben", "Department: none → Ops", "Approves own requests: no → yes", "Working days: Mon, Tue, Wed, Thu, Fri → Mon, Tue, Wed, Thu"],
  );
  assert.deepEqual(describeAuditChange(null, { leaveTypeId: "t9", approverId: "u9", days: 2.5 }, names), [
    "Leave type: another leave type",
    "Approver: someone else",
    "Days: 2.5",
  ]);
  assert.deepEqual(describeAuditChange({ name: "Ops" }, null, names), ["Name: was Ops"]);
});

test("fields without a label are spelled out from camelCase", () => {
  assert.equal(auditFieldLabel("carriedOverDays"), "Carried over");
  assert.equal(auditFieldLabel("someNewField"), "Some new field");
});

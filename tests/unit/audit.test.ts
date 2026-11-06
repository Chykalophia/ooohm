import assert from "node:assert/strict";
import { test } from "node:test";
import { auditActionLabel, auditFieldLabel, describeAuditChange, diffAuditSnapshots, isAuditAction } from "@/domain/audit";
import { ADMIN_EVENT_TYPES, ALLOWANCE_AUDIT_ACTIONS, CALENDAR_FEED_EVENT_TYPES, leaveAuditAction } from "@/domain/events";
import { LEAVE_STATUSES } from "@/domain/leave-request";

const names = {
  person: (id: string) => ({ u1: "Ana", u2: "Ben" })[id],
  department: (id: string) => ({ d1: "Ops" })[id],
  leaveType: (id: string) => ({ t1: "PTO" })[id],
};

test("every action the app writes has a label", () => {
  const written = [
    // Every leave transition: the non-status events, and each status a request can move into.
    ...(["requested", "reassigned", "recounted", ...LEAVE_STATUSES.filter((s) => s !== "pending")] as const).map((e) => leaveAuditAction(e)),
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
    "user.deletion_scheduled",
    "user.deletion_cancelled",
    "user.deleted",
    "department.created",
    "department.renamed",
    "department.deleted",
    "department.manager_changed",
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

test("a field only one snapshot has reads as a fact, not as a change from none; a null one still does", () => {
  assert.deepEqual(diffAuditSnapshots({ urlOrigin: "https://a.example" }, { urlOrigin: "https://a.example", urlChanged: true }), [
    { field: "urlChanged", after: true },
  ]);
  assert.deepEqual(describeAuditChange({ urlOrigin: "https://a.example" }, { urlOrigin: "https://a.example", urlChanged: true }, names), [
    "Full address changed: yes",
  ]);
  assert.deepEqual(describeAuditChange({ isActive: true }, { isActive: false, sessionsRevoked: 2 }, names), ["Active: yes → no", "Sessions ended: 2"]);
  assert.deepEqual(describeAuditChange({ managerId: null }, { managerId: "u2" }, names), ["Manager: none → Ben"]);
  assert.deepEqual(describeAuditChange({ note: "x", extra: 1 }, { note: "x" }, names), ["Extra: was 1"]);
});

test("fields without a label are spelled out from camelCase", () => {
  assert.equal(auditFieldLabel("carriedOverDays"), "Carried over");
  assert.equal(auditFieldLabel("someNewField"), "Some new field");
});

test("a stored instant reads as the reader's time when a formatter is given, and as stored without one", () => {
  const names = { person: () => undefined, department: () => undefined, leaveType: () => undefined };
  const after = { revokedAt: "2026-11-03T01:43:53.883Z", startDate: "2026-11-02" };
  assert.deepEqual(describeAuditChange(null, after, names), ["Turned off: 2026-11-03T01:43:53.883Z", "From: 2026-11-02"]);
  assert.deepEqual(describeAuditChange(null, after, { ...names, instant: (iso: string) => `at ${iso.slice(11, 16)}` }), [
    "Turned off: at 01:43",
    "From: 2026-11-02",
  ]);
});

test("only time fields print as times; a note shaped like a time, real or impossible, prints as typed and never throws", () => {
  const names = {
    person: () => undefined,
    department: () => undefined,
    leaveType: () => undefined,
    // As the service formats: an impossible date would throw in Intl.
    instant: (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(iso)),
  };
  assert.deepEqual(
    describeAuditChange(null, { note: "2026-13-45T99:99:99Z", decisionNote: "2026-11-03T01:43:53.883Z", revokedAt: "2026-11-03T01:43:53.883Z" }, names),
    ["Note: 2026-13-45T99:99:99Z", "Decision note: 2026-11-03T01:43:53.883Z", "Turned off: 1:43 AM"],
  );
  assert.deepEqual(describeAuditChange(null, { revokedAt: "2026-13-45T99:99:99Z" }, names), ["Turned off: 2026-13-45T99:99:99Z"], "an impossible stored time prints as stored");
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApprovalCandidate, ApprovalRequester } from "@/domain/approval-rule";
import { ManagerApprovalRule, reassignApprover } from "@/domain/approval-rule";
import { isDomainError } from "@/domain/errors";

const rule = new ManagerApprovalRule();

const employee = (over: Partial<ApprovalRequester> = {}): ApprovalRequester => ({
  id: "emp",
  role: "employee",
  canSelfApprove: false,
  managerId: "mgr",
  ...over,
});
const person = (id: string, createdAt: string, isActive = true): ApprovalCandidate => ({
  id,
  isActive,
  createdAt: new Date(createdAt),
});
const manager = person("mgr", "2026-02-01");

test("self-approval approves on the spot, whatever the manager setup", () => {
  assert.deepEqual(rule.resolve({ requester: employee({ canSelfApprove: true }), manager, departmentManager: null, admins: [] }), {
    kind: "auto_approve",
    approverId: "emp",
  });
  assert.deepEqual(rule.resolve({ requester: employee({ canSelfApprove: true, managerId: null }), manager: null, departmentManager: null, admins: [] }), {
    kind: "auto_approve",
    approverId: "emp",
  });
});

test("without self-approval the same requester is routed to their manager", () => {
  assert.deepEqual(rule.resolve({ requester: employee({ canSelfApprove: false }), manager, departmentManager: null, admins: [] }), {
    kind: "route",
    approverId: "mgr",
  });
});

test("an inactive manager falls back to the longest-standing active admin", () => {
  const admins = [person("a-new", "2026-05-01"), person("a-old-gone", "2025-01-01", false), person("a-old", "2026-01-01")];
  assert.deepEqual(rule.resolve({ requester: employee(), manager: person("mgr", "2026-02-01", false), departmentManager: null, admins }), {
    kind: "route",
    approverId: "a-old",
  });
});

test("no manager falls back to an admin; ties on created time break by id", () => {
  const admins = [person("b", "2026-01-01"), person("a", "2026-01-01")];
  assert.deepEqual(rule.resolve({ requester: employee({ managerId: null }), manager: null, departmentManager: null, admins }), {
    kind: "route",
    approverId: "a",
  });
});

test("being your own manager is ignored", () => {
  const admins = [person("adm", "2026-01-01")];
  assert.deepEqual(rule.resolve({ requester: employee({ managerId: "emp" }), manager: person("emp", "2026-01-01"), departmentManager: null, admins }), {
    kind: "route",
    approverId: "adm",
  });
});

test("an admin's request goes to another admin, never to themself while one exists", () => {
  const admins = [person("me", "2025-01-01"), person("other", "2026-01-01")];
  assert.deepEqual(rule.resolve({ requester: employee({ id: "me", role: "admin", managerId: null }), manager: null, departmentManager: null, admins }), {
    kind: "route",
    approverId: "other",
  });
});

test("a company's only admin is routed their own request", () => {
  const admins = [person("me", "2025-01-01")];
  assert.deepEqual(rule.resolve({ requester: employee({ id: "me", role: "admin", managerId: null }), manager: null, departmentManager: null, admins }), {
    kind: "route",
    approverId: "me",
  });
});

test("nobody to approve a non-admin is an error, for employees and managers alike", () => {
  for (const role of ["employee", "manager"] as const) {
    assert.throws(
      () => rule.resolve({ requester: employee({ role, managerId: null }), manager: null, departmentManager: null, admins: [person("x", "2026-01-01", false)] }),
      (e) => isDomainError(e, "no_approver"),
      role,
    );
  }
});

describe("department managers", () => {
  const admins = [person("adm", "2026-01-01")];
  const head = person("head", "2026-03-01");

  test("someone with no manager of their own goes to their department's manager", () => {
    assert.deepEqual(rule.resolve({ requester: employee({ managerId: null }), manager: null, departmentManager: head, admins }), {
      kind: "route",
      approverId: "head",
    });
  });

  test("a direct manager comes first; an inactive one falls through to the department's manager", () => {
    assert.deepEqual(rule.resolve({ requester: employee(), manager, departmentManager: head, admins }), { kind: "route", approverId: "mgr" });
    assert.deepEqual(
      rule.resolve({ requester: employee(), manager: person("mgr", "2026-02-01", false), departmentManager: head, admins }),
      { kind: "route", approverId: "head" },
    );
  });

  test("an inactive department manager, or one asking for themself, falls back to an admin", () => {
    const requester = employee({ managerId: null });
    assert.deepEqual(rule.resolve({ requester, manager: null, departmentManager: person("head", "2026-03-01", false), admins }), {
      kind: "route",
      approverId: "adm",
    });
    assert.deepEqual(
      rule.resolve({ requester: employee({ id: "head", managerId: null }), manager: null, departmentManager: head, admins }),
      { kind: "route", approverId: "adm" },
    );
  });

  test("self-approval still wins over a department manager", () => {
    assert.deepEqual(
      rule.resolve({ requester: employee({ canSelfApprove: true, managerId: null }), manager: null, departmentManager: head, admins }),
      { kind: "auto_approve", approverId: "emp" },
    );
  });

  test("re-routing follows the department manager the same way", () => {
    assert.equal(reassignApprover(rule, { requester: employee({ canSelfApprove: true, managerId: null }), manager: null, departmentManager: head, admins }), "head");
  });
});

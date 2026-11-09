import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApprovalCandidate, ApprovalRequester } from "@/domain/approval-rule";
import {
  APPROVAL_MODES,
  approvalRuleFor,
  DEFAULT_APPROVAL_MODE,
  isApprovalMode,
  ManagerApprovalRule,
  readApprovalMode,
} from "@/domain/approval-rule";
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
  assert.deepEqual(rule.resolve({ requester: employee({ canSelfApprove: true }), manager, admins: [] }), {
    kind: "auto_approve",
    approverId: "emp",
  });
  assert.deepEqual(rule.resolve({ requester: employee({ canSelfApprove: true, managerId: null }), manager: null, admins: [] }), {
    kind: "auto_approve",
    approverId: "emp",
  });
});

test("without self-approval the same requester is routed to their manager", () => {
  assert.deepEqual(rule.resolve({ requester: employee({ canSelfApprove: false }), manager, admins: [] }), {
    kind: "route",
    approverId: "mgr",
  });
});

test("an inactive manager falls back to the longest-standing active admin", () => {
  const admins = [person("a-new", "2026-05-01"), person("a-old-gone", "2025-01-01", false), person("a-old", "2026-01-01")];
  assert.deepEqual(rule.resolve({ requester: employee(), manager: person("mgr", "2026-02-01", false), admins }), {
    kind: "route",
    approverId: "a-old",
  });
});

test("no manager falls back to an admin; ties on created time break by id", () => {
  const admins = [person("b", "2026-01-01"), person("a", "2026-01-01")];
  assert.deepEqual(rule.resolve({ requester: employee({ managerId: null }), manager: null, admins }), {
    kind: "route",
    approverId: "a",
  });
});

test("being your own manager is ignored", () => {
  const admins = [person("adm", "2026-01-01")];
  assert.deepEqual(rule.resolve({ requester: employee({ managerId: "emp" }), manager: person("emp", "2026-01-01"), admins }), {
    kind: "route",
    approverId: "adm",
  });
});

test("an admin's request goes to another admin, never to themself while one exists", () => {
  const admins = [person("me", "2025-01-01"), person("other", "2026-01-01")];
  assert.deepEqual(rule.resolve({ requester: employee({ id: "me", role: "admin", managerId: null }), manager: null, admins }), {
    kind: "route",
    approverId: "other",
  });
});

test("a company's only admin is routed their own request", () => {
  const admins = [person("me", "2025-01-01")];
  assert.deepEqual(rule.resolve({ requester: employee({ id: "me", role: "admin", managerId: null }), manager: null, admins }), {
    kind: "route",
    approverId: "me",
  });
});

test("nobody to approve a non-admin is an error, for employees and managers alike", () => {
  for (const role of ["employee", "manager"] as const) {
    assert.throws(
      () => rule.resolve({ requester: employee({ role, managerId: null }), manager: null, admins: [person("x", "2026-01-01", false)] }),
      (e) => isDomainError(e, "no_approver"),
      role,
    );
  }
});

describe("heads-up time off (approval turned off for the company)", () => {
  const headsUp = approvalRuleFor("heads_up");

  test("every request is booked at once, decided by the requester, and their manager is told", () => {
    assert.deepEqual(headsUp.resolve({ requester: employee(), manager, admins: [] }), {
      kind: "auto_approve",
      approverId: "emp",
      informId: "mgr",
    });
  });

  test("self-approvers are booked the same way, and their manager is still told", () => {
    assert.deepEqual(headsUp.resolve({ requester: employee({ canSelfApprove: true }), manager, admins: [] }), {
      kind: "auto_approve",
      approverId: "emp",
      informId: "mgr",
    });
  });

  test("without an active manager, the longest-standing other admin is told", () => {
    const admins = [person("a-new", "2026-05-01"), person("a-old", "2026-01-01")];
    assert.deepEqual(headsUp.resolve({ requester: employee({ managerId: null }), manager: null, admins }), {
      kind: "auto_approve",
      approverId: "emp",
      informId: "a-old",
    });
  });

  test("nobody to tell never blocks the time off, and nobody is told about their own", () => {
    for (const role of ["employee", "manager"] as const) {
      assert.deepEqual(headsUp.resolve({ requester: employee({ role, managerId: null }), manager: null, admins: [] }), {
        kind: "auto_approve",
        approverId: "emp",
        informId: null,
      });
    }
    const onlyAdmin = employee({ id: "me", role: "admin", managerId: null });
    assert.deepEqual(headsUp.resolve({ requester: onlyAdmin, manager: null, admins: [person("me", "2025-01-01")] }), {
      kind: "auto_approve",
      approverId: "me",
      informId: null,
    });
  });

  test("approval required is the manager rule, unchanged", () => {
    const required = approvalRuleFor("required");
    assert.ok(required instanceof ManagerApprovalRule);
    assert.deepEqual(required.resolve({ requester: employee(), manager, admins: [] }), { kind: "route", approverId: "mgr" });
  });

  test("the modes are a closed list, approval required first as the default", () => {
    assert.deepEqual(APPROVAL_MODES, ["required", "heads_up"]);
    assert.equal(DEFAULT_APPROVAL_MODE, "required");
    assert.equal(isApprovalMode("heads_up"), true);
    assert.equal(isApprovalMode("notify"), false);
    assert.equal(readApprovalMode("garbage"), "required", "an unknown stored value falls back to asking first");
    assert.equal(readApprovalMode("heads_up"), "heads_up");
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalCandidate, ApprovalContext } from "@/modules/approvals/domain/approval-context";
import { approverFor, ManagerApprovalRule } from "@/modules/approvals/domain/approver-for";

const at = (iso: string) => new Date(iso);
const active = (id: string, createdAt = "2025-01-01"): ApprovalCandidate => ({ id, isActive: true, createdAt: at(createdAt) });
const inactive = (id: string): ApprovalCandidate => ({ id, isActive: false, createdAt: at("2024-01-01") });

function context(over: Partial<ApprovalContext> = {}, requester: Partial<ApprovalContext["requester"]> = {}): ApprovalContext {
  return {
    requester: { id: "ana", role: "employee", canSelfApprove: false, managerId: null, ...requester },
    manager: null,
    departmentManager: null,
    admins: [],
    ...over,
  };
}

test("the manager comes first, then the department's manager, then the oldest other admin", () => {
  const admins = [active("a2", "2025-02-01"), active("a1", "2025-01-01")];
  assert.equal(approverFor(context({ manager: active("mo"), departmentManager: active("lead"), admins })), "mo");
  assert.equal(approverFor(context({ manager: inactive("mo"), departmentManager: active("lead"), admins })), "lead");
  assert.equal(approverFor(context({ manager: inactive("mo"), departmentManager: inactive("lead"), admins })), "a1");
  assert.equal(approverFor(context({ admins: [inactive("a0"), ...admins] })), "a1", "an inactive admin is skipped");
});

test("admins created together are ordered by id, so routing never depends on read order", () => {
  const same = "2025-01-01";
  assert.equal(approverFor(context({ admins: [active("b", same), active("a", same)] })), "a");
});

test("the requester never approves for themself through a manager slot or the admin fallback", () => {
  const ctx = context({ manager: active("ana"), departmentManager: active("ana"), admins: [active("ana"), active("a1", "2025-06-01")] });
  assert.equal(approverFor(ctx), "a1");
});

test("an admin with nobody else routes to themself; anyone else with nobody gets no approver", () => {
  assert.equal(approverFor(context({}, { id: "a1", role: "admin" })), "a1");
  assert.equal(approverFor(context()), null);
});

test("self-approve approves at submit, decided by the requester; the reassignment rule ignores it", () => {
  const ctx = context({ manager: active("mo") }, { canSelfApprove: true });
  assert.deepEqual(new ManagerApprovalRule().resolve(ctx), { kind: "auto_approve", approverId: "ana" });
  assert.equal(approverFor(ctx), "mo", "a pending request is never self-approved by a re-route");
});

test("with nobody to route to, submitting fails with no_approver", () => {
  assert.throws(() => new ManagerApprovalRule().resolve(context()), (e: unknown) => (e as { code?: string }).code === "no_approver");
});

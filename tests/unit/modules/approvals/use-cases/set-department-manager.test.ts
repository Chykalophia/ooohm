import assert from "node:assert/strict";
import { test } from "node:test";
import type { DepartmentManagerChange } from "@/modules/organisation";
import { type SetDepartmentManagerDeps, setDepartmentManager } from "@/modules/approvals/application/use-cases/set-department-manager";
import { unwrap } from "@/shared/lib/result";
import { type ApprovalKit, approvalKit } from "../fakes/ports";
import { first } from "../../../../support/present";

const ANA = "00000000-0000-4000-8000-0000000000b1";
const MO = "00000000-0000-4000-8000-0000000000b2";
const A1 = "00000000-0000-4000-8000-0000000000b3";
const DEPT = "00000000-0000-4000-8000-0000000000d1";

/** Ana has no manager and sits in DEPT, which has none yet; A1 is the only admin. */
function team(): ApprovalKit {
  const kit = approvalKit();
  kit.add(A1, "A1", { role: "admin", createdAt: new Date("2024-01-01T00:00:00Z") });
  kit.add(MO, "Mo", { role: "manager" });
  kit.add(ANA, "Ana", { departmentId: DEPT });
  kit.contexts.departments.set(DEPT, null);
  return kit;
}

/** The use case on approvals' fakes, with organisation's department step setting the manager in memory. */
function withDepartments(kit: ApprovalKit) {
  const calls: (string | null)[] = [];
  const deps: SetDepartmentManagerDeps = {
    approvals: kit.deps,
    unitOfWork: (companyId, work) =>
      kit.deps.unitOfWork(companyId, (store) =>
        work(
          {
            change: async (_actor, id, managerId): Promise<DepartmentManagerChange> => {
              calls.push(managerId);
              const changed = kit.contexts.departments.get(id) !== managerId;
              kit.contexts.departments.set(id, managerId);
              return { department: { id, name: "Support", managerId, maxOff: null }, changed };
            },
            pendingInDepartment: async (company, departmentId) =>
              [...kit.requests.rows.values()].filter(
                (r) => r.companyId === company && r.status === "pending" && kit.contexts.people.get(r.userId)?.departmentId === departmentId,
              ),
          },
          store,
        ),
      ),
  };
  return { deps, calls };
}

test("only an admin may set a department's manager, and the department id must be a uuid", async () => {
  const kit = team();
  const { deps, calls } = withDepartments(kit);
  const forbidden = await setDepartmentManager(deps, kit.as(ANA), DEPT, MO);
  assert.ok(!forbidden.ok && forbidden.error.code === "forbidden");
  const missing = await setDepartmentManager(deps, kit.as(A1), "not-a-uuid", MO);
  assert.ok(!missing.ok && missing.error.code === "not_found");
  assert.equal(calls.length, 0);
});

test("a new department manager takes the department's pending requests, with a review email", async () => {
  const kit = team();
  kit.request(ANA, A1);
  const { deps } = withDepartments(kit);
  const r = unwrap(await setDepartmentManager(deps, kit.as(A1), DEPT, MO));
  assert.deepEqual(r, { id: DEPT, name: "Support", managerId: MO, maxOff: null, requestsReassigned: 1 });
  assert.deepEqual(kit.changes.kinds(), ["reassigned"]);
  assert.equal(first(kit.changes.written).after.approverId, MO);
  assert.deepEqual(kit.sent.map((n) => [n.type, n.to]), [["leave.requested", "mo@example.test"]]);
});

test("setting the manager the department already has moves nothing", async () => {
  const kit = team();
  kit.contexts.departments.set(DEPT, MO);
  kit.request(ANA, MO);
  const { deps } = withDepartments(kit);
  const r = unwrap(await setDepartmentManager(deps, kit.as(A1), DEPT, MO));
  assert.equal(r.requestsReassigned, 0);
  assert.deepEqual(kit.changes.written, []);
  assert.deepEqual(kit.sent, []);
});

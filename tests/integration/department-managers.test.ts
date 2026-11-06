import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createDepartment, listDepartmentsForAdmin, setDepartmentManager } from "@/server/services/admin-departments";
import { deactivatePerson, updatePerson } from "@/server/services/admin-people";
import { deletePerson } from "@/server/services/admin-people-deletion";
import { decideLeaveRequest } from "@/server/services/approvals";
import { addLeaveFor } from "@/server/services/leave-on-behalf";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { getTeamMember } from "@/server/services/team-member";
import { rejectsWith } from "./assertions";
import { companyAudit, companyEvents, decidable, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const ZERO_UUID = "00000000-0000-4000-8000-000000000000";
const NOW = new Date("2026-11-03T09:00:00Z");

describe("department managers", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  /** A company with a Design department holding ana (no manager of her own) and bo (managed by mgr). */
  async function seed() {
    const co = await seedCompany(t.db, {
      boss: { role: "admin", createdAt: "2025-01-01" },
      head: { role: "manager" },
      mgr: { role: "manager" },
      ana: {},
      bo: { managerKey: "mgr" },
      out: {},
    });
    const ctx = createTestContext(t.db, { now: NOW });
    const design = await createDepartment(ctx, co.people.boss, "Design");
    for (const key of ["ana", "bo"] as const) {
      await t.db.update(schema.user).set({ departmentId: design.id }).where(eq(schema.user.id, co.people[key].id));
    }
    return { co, ctx, design };
  }

  const day = (leaveTypeId: string, startDate = "2026-11-10") => ({ leaveTypeId, startDate, dayPortion: "full" as const });

  async function approverOf(requestId: string) {
    const [row] = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, requestId));
    return row.approverId;
  }

  test("an admin sets and clears a department's manager, audited, with the manager in every department event", async () => {
    const { co, ctx, design } = await seed();
    const { boss, head } = co.people;

    const set = await setDepartmentManager(ctx, boss, design.id, head.id);
    assert.equal(set.managerId, head.id);
    await setDepartmentManager(ctx, boss, design.id, head.id);
    const [listed] = await listDepartmentsForAdmin(ctx, boss);
    assert.deepEqual(
      { id: listed.id, managerId: listed.managerId, managerName: listed.managerName },
      { id: design.id, managerId: head.id, managerName: "Head" },
    );

    const cleared = await setDepartmentManager(ctx, boss, design.id, null);
    assert.equal(cleared.managerId, null);

    const audit = await companyAudit(t.db, co.companyId, "department.manager");
    assert.deepEqual(
      audit.map((a) => [a.action, a.actorId, a.entityId, a.before, a.after]),
      [
        ["department.manager_changed", boss.id, design.id, { managerId: null }, { managerId: head.id }],
        ["department.manager_changed", boss.id, design.id, { managerId: head.id }, { managerId: null }],
      ],
      "setting the same manager again records nothing",
    );
    const events = await companyEvents(t.db, co.companyId, "department.");
    assert.deepEqual(
      events.map((e) => [e.type, e.payload]),
      [
        ["department.created", { departmentId: design.id, name: "Design", managerId: null, actorId: boss.id, actor: { type: "user", id: boss.id } }],
        ["department.manager_changed", { departmentId: design.id, name: "Design", managerId: head.id, actorId: boss.id, actor: { type: "user", id: boss.id } }],
        ["department.manager_changed", { departmentId: design.id, name: "Design", managerId: null, actorId: boss.id, actor: { type: "user", id: boss.id } }],
      ],
    );
  });

  test("the manager must be an active member of the company; non-admins and unknown departments are refused", async () => {
    const { co, ctx, design } = await seed();
    const other = await seedCompany(t.db, { stranger: {} });
    const { boss, head, out } = co.people;
    await t.db.update(schema.user).set({ isActive: false }).where(eq(schema.user.id, out.id));

    await rejectsWith(setDepartmentManager(ctx, boss, design.id, out.id), "invalid_manager");
    await rejectsWith(setDepartmentManager(ctx, boss, design.id, other.people.stranger.id), "invalid_manager");
    await rejectsWith(setDepartmentManager(ctx, boss, design.id, "nobody"), "invalid_manager");
    await rejectsWith(setDepartmentManager(ctx, head, design.id, head.id), "forbidden");
    await rejectsWith(setDepartmentManager(ctx, boss, ZERO_UUID, head.id), "not_found");
    await rejectsWith(setDepartmentManager(ctx, boss, "not-a-uuid", head.id), "not_found");
    assert.equal((await companyAudit(t.db, co.companyId, "department.manager")).length, 0);
  });

  test("requests from people without a manager go to their department's manager, who may decide them", async () => {
    const { co, ctx, design } = await seed();
    const { boss, head, mgr, ana, bo } = co.people;
    await setDepartmentManager(ctx, boss, design.id, head.id);

    const fromAna = await submitLeaveRequest(ctx, ana, day(co.pto));
    const fromBo = await submitLeaveRequest(ctx, bo, day(co.pto));
    assert.equal(fromAna.approverId, head.id, "no manager of her own: the department's manager");
    assert.equal(fromBo.approverId, mgr.id, "a person's own manager comes first");

    const inbox = await decidable(ctx, head);
    assert.deepEqual(
      inbox.items.map((r) => r.id),
      [fromAna.id],
    );
    const decided = await decideLeaveRequest(ctx, head, { requestId: fromAna.id, decision: "approve" });
    assert.equal(decided.status, "approved");
  });

  test("changing the department's manager re-routes its pending requests, and the old one can no longer decide them", async () => {
    const { co, ctx, design } = await seed();
    const { boss, head, mgr, ana, bo } = co.people;
    await setDepartmentManager(ctx, boss, design.id, head.id);
    const fromAna = await submitLeaveRequest(ctx, ana, day(co.pto));
    const fromBo = await submitLeaveRequest(ctx, bo, day(co.pto));

    await setDepartmentManager(ctx, boss, design.id, null);
    assert.equal(await approverOf(fromAna.id), boss.id, "back to the admin fallback");
    assert.equal(await approverOf(fromBo.id), mgr.id, "untouched: bo has his own manager");
    await rejectsWith(decideLeaveRequest(ctx, head, { requestId: fromAna.id, decision: "approve" }), "forbidden");

    await setDepartmentManager(ctx, boss, design.id, head.id);
    assert.equal(await approverOf(fromAna.id), head.id);
    const reassigned = await companyAudit(t.db, co.companyId, "leave_request.reassigned");
    assert.equal(reassigned.length, 2);
  });

  test("moving someone into or out of a department re-routes their pending requests", async () => {
    const { co, ctx, design } = await seed();
    const { boss, head, out } = co.people;
    await setDepartmentManager(ctx, boss, design.id, head.id);
    const req = await submitLeaveRequest(ctx, out, day(co.pto));
    assert.equal(req.approverId, boss.id);

    const person = { name: "Out", managerId: null, role: "employee", canSelfApprove: false };
    const moved = await updatePerson(ctx, boss, out.id, { ...person, departmentId: design.id });
    assert.equal(moved.requestsReassigned, 1);
    assert.equal(await approverOf(req.id), head.id);

    await updatePerson(ctx, boss, out.id, { ...person, departmentId: null });
    assert.equal(await approverOf(req.id), boss.id);
  });

  test("deactivating a department manager hands their requests on", async () => {
    const { co, ctx, design } = await seed();
    const { boss, head, ana } = co.people;
    await setDepartmentManager(ctx, boss, design.id, head.id);
    const req = await submitLeaveRequest(ctx, ana, day(co.pto));

    const result = await deactivatePerson(ctx, boss, head.id);
    assert.equal(result.requestsReassigned, 1);
    assert.equal(await approverOf(req.id), boss.id);
    const kept = await setDepartmentManager(ctx, boss, design.id, head.id);
    assert.equal(kept.managerId, head.id, "saving the form unchanged keeps them, deactivated as they are");
    await setDepartmentManager(ctx, boss, design.id, null);
    await rejectsWith(setDepartmentManager(ctx, boss, design.id, head.id), "invalid_manager");
  });

  test("a department manager sees their department's leave details and can add time off for its people, nobody else's", async () => {
    const { co, ctx, design } = await seed();
    const { boss, head, bo, out } = co.people;
    await setDepartmentManager(ctx, boss, design.id, head.id);

    const page = await getTeamMember(ctx, head, bo.id);
    assert.ok(page.balances, "sees the balances of someone in their department");
    assert.ok(page.addLeave, "and may add time off for them");
    const outsider = await getTeamMember(ctx, head, out.id);
    assert.equal(outsider.balances, null);
    assert.equal(outsider.addLeave, null);

    const added = await addLeaveFor(ctx, head, bo.id, day(co.pto));
    assert.equal(added.status, "approved");
    await rejectsWith(addLeaveFor(ctx, head, out.id, day(co.pto)), "forbidden");
  });

  test("deleting a deactivated department manager clears them from the department, audited", async () => {
    const { co, ctx, design } = await seed();
    const { boss, head } = co.people;
    await setDepartmentManager(ctx, boss, design.id, head.id);
    await deactivatePerson(ctx, boss, head.id);

    await deletePerson(ctx, boss, head.id, { mode: "records_kept", confirmName: "Head" });
    const [listed] = await listDepartmentsForAdmin(ctx, boss);
    assert.equal(listed.managerId, null, "no tombstone left managing the department");
    const audit = await companyAudit(t.db, co.companyId, "department.manager");
    assert.deepEqual(
      audit.map((a) => [a.actorId, a.before, a.after]),
      [
        [boss.id, { managerId: null }, { managerId: head.id }],
        [boss.id, { managerId: head.id }, { managerId: null }],
      ],
    );
  });
});

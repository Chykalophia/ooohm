import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createDepartment, listDepartmentsForAdmin, setDepartmentLimit } from "@/server/services/admin-departments";
import { draftCoverage } from "@/server/services/also-off";
import { getApprovalTriage } from "@/server/services/approvals";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { rejectsWith } from "./assertions";
import { companyAudit, companyEvents, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const NOW = new Date("2026-11-03T09:00:00Z");

describe("coverage limits", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  /** Design holds ana, bo and cy, all reporting to boss; dee is in no department. */
  async function seed() {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      head: { role: "manager" },
      ana: { managerKey: "boss" },
      bo: { managerKey: "boss" },
      cy: { managerKey: "boss" },
      dee: { managerKey: "boss" },
    });
    const ctx = createTestContext(t.db, { now: NOW });
    const design = await createDepartment(ctx, co.people.boss, "Design");
    for (const key of ["ana", "bo", "cy"] as const) {
      await t.db.update(schema.user).set({ departmentId: design.id }).where(eq(schema.user.id, co.people[key].id));
    }
    return { co, ctx, design };
  }

  const day = (leaveTypeId: string, startDate: string, endDate = startDate) => ({ leaveTypeId, startDate, endDate, dayPortion: "full" as const });

  test("an admin sets and clears a department's limit, audited, with the limit in its events", async () => {
    const { co, ctx, design } = await seed();
    const { boss, head } = co.people;

    assert.equal((await setDepartmentLimit(ctx, boss, design.id, 2)).maxOff, 2);
    await setDepartmentLimit(ctx, boss, design.id, 2);
    assert.equal((await listDepartmentsForAdmin(ctx, boss))[0].maxOff, 2);
    assert.equal((await setDepartmentLimit(ctx, boss, design.id, null)).maxOff, null);

    for (const bad of [0, -1, 1.5, 1000]) await rejectsWith(setDepartmentLimit(ctx, boss, design.id, bad), "invalid_input");
    await rejectsWith(setDepartmentLimit(ctx, head, design.id, 2), "forbidden");

    const audit = await companyAudit(t.db, co.companyId, "department.limit");
    assert.deepEqual(
      audit.map((a) => [a.action, a.actorId, a.before, a.after]),
      [
        ["department.limit_changed", boss.id, { maxOff: null }, { maxOff: 2 }],
        ["department.limit_changed", boss.id, { maxOff: 2 }, { maxOff: null }],
      ],
      "setting the same limit again records nothing",
    );
    const events = await companyEvents(t.db, co.companyId, "department.limit");
    assert.deepEqual(
      events.map((e) => e.payload),
      [
        { departmentId: design.id, name: "Design", managerId: null, maxOff: 2, actorId: boss.id, actor: { type: "user", id: boss.id } },
        { departmentId: design.id, name: "Design", managerId: null, maxOff: null, actorId: boss.id, actor: { type: "user", id: boss.id } },
      ],
    );
  });

  test("past the limit the requester's preview, the approver's triage and the review email warn; nothing is blocked", async () => {
    const { co, ctx, design } = await seed();
    const { boss, ana, bo, cy, dee } = co.people;
    await setDepartmentLimit(ctx, boss, design.id, 2);

    // Ana is approved Tue to Thu; Bo is pending on Wed. Pending counts.
    const anaReq = await submitLeaveRequest(ctx, ana, day(co.pto, "2026-11-10", "2026-11-12"));
    await submitLeaveRequest(ctx, bo, day(co.pto, "2026-11-11"));
    assert.equal(await draftCoverage(t.db, co.companyId, cy.id, day(co.pto, "2026-11-09")), null, "Monday: only Cy");
    assert.equal(await draftCoverage(t.db, co.companyId, cy.id, day(co.pto, "2026-11-10")), null, "Tuesday: Ana and Cy, at the limit");
    assert.equal(
      await draftCoverage(t.db, co.companyId, cy.id, day(co.pto, "2026-11-11")),
      "This would put 3 people in Design off on Wed, Nov 11. The limit is 2.",
    );
    assert.equal(await draftCoverage(t.db, co.companyId, dee.id, day(co.pto, "2026-11-11")), null, "no department, no limit");
    assert.equal(await draftCoverage(t.db, co.companyId, ana.id, day(co.pto, "2026-11-11")), null, "Ana's own leave isn't counted twice");

    await ctx.settle();
    ctx.sent.length = 0;
    const cyReq = await submitLeaveRequest(ctx, cy, day(co.pto, "2026-11-11", "2026-11-12"));
    assert.equal(cyReq.status, "pending", "a warning never blocks");
    await ctx.settle();
    const review = ctx.sent.find((m) => m.to === boss.email);
    assert.match(review?.text ?? "", /This would put 3 people in Design off on Wed, Nov 11\. The limit is 2\./);

    const { items } = await getApprovalTriage(ctx, boss);
    const byId = new Map(items.map((r) => [r.id, r.alsoOff]));
    assert.equal(byId.get(cyReq.id)?.coverage, "This would put 3 people in Design off on Wed, Nov 11. The limit is 2.");
    assert.equal(byId.get(anaReq.id)?.coverage, "This would put 3 people in Design off on Wed, Nov 11. The limit is 2.");

    // Without a limit, nobody is warned.
    await setDepartmentLimit(ctx, boss, design.id, null);
    const again = await getApprovalTriage(ctx, boss);
    assert.ok(again.items.every((r) => r.alsoOff?.coverage === null));
  });
});

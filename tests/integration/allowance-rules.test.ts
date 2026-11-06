import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { listAllowanceRulesForAdmin, removeAllowanceRule, setAllowanceRule } from "@/server/services/admin-allowance-rules";
import { createDepartment, deleteDepartment } from "@/server/services/admin-departments";
import { createLevel, deleteLevel, listLevelsForAdmin, renameLevel } from "@/server/services/admin-levels";
import { deactivatePerson, updatePerson } from "@/server/services/admin-people";
import { deletePerson } from "@/server/services/admin-people-deletion";
import { getBalanceSummary } from "@/server/services/balances";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { runYearRollover } from "@/server/services/rollover";
import { rejectsWith } from "./assertions";
import { addLeaveType, allowancesOf, companyAudit, companyEvents, seedCompany, setAllowance } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const ZERO_UUID = "00000000-0000-4000-8000-000000000000";
const NOW = new Date("2026-11-03T09:00:00Z");

describe("allowance rules by department and level", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  /**
   * A company whose VAC type gives 15 days by default, with a Dev department (ana, a
   * senior; ivy, an intern) and bo outside it.
   */
  async function seed() {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {}, ivy: {}, bo: {} });
    const ctx = createTestContext(t.db, { now: NOW });
    const { boss } = co.people;
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 15 });
    const dev = await createDepartment(ctx, boss, "Dev");
    const senior = await createLevel(ctx, boss, "Senior");
    const intern = await createLevel(ctx, boss, "Intern");
    await place(co.people.ana.id, dev.id, senior.id);
    await place(co.people.ivy.id, dev.id, intern.id);
    return { co, ctx, vac, dev, senior, intern };
  }

  async function place(userId: string, departmentId: string | null, levelId: string | null) {
    await t.db.update(schema.user).set({ departmentId, levelId }).where(eq(schema.user.id, userId));
  }

  async function allowanceOf(ctx: ReturnType<typeof createTestContext>, actor: Parameters<typeof getBalanceSummary>[1], leaveTypeId: string) {
    const summary = await getBalanceSummary(ctx, actor);
    const item = summary.items.find((i) => i.leaveTypeId === leaveTypeId);
    assert.ok(item?.balance.tracked, "tracked");
    return item.balance.allowance;
  }

  test("levels: create, rename and delete when empty, each audited; duplicates refused ignoring case", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
    const ctx = createTestContext(t.db, { now: NOW });
    const { boss, ana } = co.people;

    const lead = await createLevel(ctx, boss, "  Lead ");
    assert.equal(lead.name, "Lead");
    await rejectsWith(createLevel(ctx, boss, "LEAD"), "already_exists");
    await renameLevel(ctx, boss, lead.id, "Principal");
    await place(ana.id, null, lead.id);
    assert.deepEqual(
      (await listLevelsForAdmin(ctx, boss)).map((l) => [l.name, l.members]),
      [["Principal", 1]],
    );
    await rejectsWith(deleteLevel(ctx, boss, lead.id), "level_not_empty");
    await place(ana.id, null, null);
    await deleteLevel(ctx, boss, lead.id);
    await rejectsWith(createLevel(ctx, ana, "Nope"), "forbidden");

    assert.deepEqual(
      (await companyEvents(t.db, co.companyId, "level.")).map((e) => [e.type, e.payload]),
      [
        ["level.created", { levelId: lead.id, name: "Lead", actorId: boss.id, actor: { type: "user", id: boss.id } }],
        ["level.renamed", { levelId: lead.id, name: "Principal", actorId: boss.id, actor: { type: "user", id: boss.id } }],
        ["level.deleted", { levelId: lead.id, name: "Principal", actorId: boss.id, actor: { type: "user", id: boss.id } }],
      ],
    );
    assert.equal((await companyAudit(t.db, co.companyId, "level.")).length, 3);
  });

  test("a department's rule sets its people's allowance; the most specific rule wins; others keep the default", async () => {
    const { co, ctx, vac, dev, senior, intern } = await seed();
    const { boss, ana, ivy, bo } = co.people;

    await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 20 });
    await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: null, levelId: intern.id, days: 10 });

    assert.equal(await allowanceOf(ctx, ana, vac), 20, "senior in Dev: the department's rule");
    assert.equal(await allowanceOf(ctx, ivy, vac), 10, "intern in Dev: the level's rule is more specific");
    assert.equal(await allowanceOf(ctx, bo, vac), 15, "outside both: the type's default");

    await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: null, levelId: senior.id, days: 22 });
    assert.equal(await allowanceOf(ctx, ana, vac), 22, "senior: the level's rule beats the department's");
    await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: dev.id, levelId: senior.id, days: 25 });
    assert.equal(await allowanceOf(ctx, ana, vac), 25, "senior in Dev: department and level beat both");

    const rules = await listAllowanceRulesForAdmin(ctx, boss, vac);
    assert.deepEqual(
      rules.map((r) => [r.departmentName, r.levelName, r.days]),
      [
        ["Dev", null, 20],
        [null, "Intern", 10],
        [null, "Senior", 22],
        ["Dev", "Senior", 25],
      ],
    );

    // The rule is what submit enforces, too.
    await rejectsWith(
      submitLeaveRequest(ctx, ivy, { leaveTypeId: vac, startDate: "2026-11-02", endDate: "2026-11-16", dayPortion: "full" }),
      "insufficient_balance",
    );
  });

  test("setting a rule again updates it; removing it brings the default back; each change is audited", async () => {
    const { co, ctx, vac, dev } = await seed();
    const { boss, ana } = co.people;

    const first = await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 20 });
    const again = await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 22.5 });
    assert.equal(again.id, first.id);
    assert.equal(await allowanceOf(ctx, ana, vac), 22.5);
    await removeAllowanceRule(ctx, boss, first.id);
    assert.equal(await allowanceOf(ctx, ana, vac), 15);

    assert.deepEqual(
      (await companyAudit(t.db, co.companyId, "allowance_rule.")).map((a) => [a.action, a.before, a.after]),
      [
        ["allowance_rule.set", null, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 20 }],
        ["allowance_rule.set", { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 20 }, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 22.5 }],
        ["allowance_rule.removed", { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 22.5 }, null],
      ],
    );
    const [event] = await companyEvents(t.db, co.companyId, "allowance_rule.set");
    assert.deepEqual(event.payload, {
      ruleId: first.id,
      leaveTypeId: vac,
      departmentId: dev.id,
      levelId: null,
      days: 20,
      actorId: boss.id,
      actor: { type: "user", id: boss.id },
    });
  });

  test("this year's rows that follow the default move with the rules; hand-set ones stay, each move audited", async () => {
    const { co, ctx, vac, dev } = await seed();
    const { boss, ana, ivy, bo } = co.people;
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: vac, year: 2026, days: 15 });
    await setAllowance(t.db, { userId: ivy.id, leaveTypeId: vac, year: 2026, days: 18 });
    await setAllowance(t.db, { userId: bo.id, leaveTypeId: vac, year: 2026, days: 15 });
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: vac, year: 2025, days: 15 });
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: vac, year: 2027, days: 15 });

    const result = await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 20 });
    assert.equal(result.allowancesUpdated, 2);
    const days = async (userId: string, year: number) =>
      (await allowancesOf(t.db, userId)).find((a) => a.leaveTypeId === vac && a.year === year)?.days;
    assert.equal(await days(ana.id, 2026), 20, "was on the default: follows the rule");
    assert.equal(await days(ivy.id, 2026), 18, "set by hand: kept");
    assert.equal(await days(bo.id, 2026), 15, "outside the department: untouched");
    assert.equal(await days(ana.id, 2025), 15, "closed years are left alone");
    assert.equal(await days(ana.id, 2027), 20, "a later year's row follows too");

    const moves = await companyAudit(t.db, co.companyId, "allowance.rule_applied");
    assert.equal(moves.length, 2);
    assert.ok(moves.every((m) => m.subjectUserId === ana.id && m.actorId === boss.id));
    const [balance] = await companyEvents(t.db, co.companyId, "balance.adjusted");
    assert.equal((balance.payload as { reason: string }).reason, "allowance_rule");

    await removeAllowanceRule(ctx, boss, result.id);
    assert.equal(await days(ana.id, 2026), 15, "back to the default with the rule gone");
  });

  test("moving someone to another department or level moves their default-following rows", async () => {
    const { co, ctx, vac, dev, senior } = await seed();
    const { boss, bo } = co.people;
    await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 20 });
    await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: dev.id, levelId: senior.id, days: 25 });
    await setAllowance(t.db, { userId: bo.id, leaveTypeId: vac, year: 2026, days: 15 });

    const person = { name: "Bo", managerId: null, role: "employee", canSelfApprove: false };
    await updatePerson(ctx, boss, bo.id, { ...person, departmentId: dev.id, levelId: null });
    const row = () =>
      t.db
        .select({ days: schema.allowances.days })
        .from(schema.allowances)
        .where(and(eq(schema.allowances.userId, bo.id), eq(schema.allowances.leaveTypeId, vac), eq(schema.allowances.year, 2026)));
    assert.deepEqual(await row(), [{ days: 20 }]);
    await updatePerson(ctx, boss, bo.id, { ...person, departmentId: dev.id, levelId: senior.id });
    assert.deepEqual(await row(), [{ days: 25 }]);
    const updates = (await companyAudit(t.db, co.companyId, "user.updated")).filter((a) => a.subjectUserId === bo.id);
    assert.deepEqual(
      updates.map((a) => [(a.before as { levelId: string | null }).levelId, (a.after as { levelId: string | null }).levelId]),
      [
        [null, null],
        [null, senior.id],
      ],
    );
    const events = (await companyEvents(t.db, co.companyId, "user.updated")).filter((e) => (e.payload as { userId: string }).userId === bo.id);
    assert.deepEqual(
      events.map((e) => (e.payload as { levelId: string | null }).levelId),
      [null, senior.id],
    );
    await rejectsWith(updatePerson(ctx, boss, bo.id, { ...person, departmentId: dev.id, levelId: ZERO_UUID }), "invalid_input");
  });

  test("deleting a level or department records the removal of its rules; a deleted person no longer holds a level", async () => {
    const { co, ctx, vac, dev, senior, intern } = await seed();
    const { boss, ana, ivy } = co.people;
    const forLevel = await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: null, levelId: intern.id, days: 10 });
    const forDept = await setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 20 });

    await deactivatePerson(ctx, boss, ivy.id);
    await deletePerson(ctx, boss, ivy.id, { mode: "records_kept", confirmName: "Ivy" });
    await deleteLevel(ctx, boss, intern.id);
    await place(ana.id, null, senior.id);
    await deleteDepartment(ctx, boss, dev.id);

    const removed = await companyEvents(t.db, co.companyId, "allowance_rule.removed");
    assert.deepEqual(
      removed.map((e) => (e.payload as { ruleId: string }).ruleId),
      [forLevel.id, forDept.id],
    );
    assert.equal((await companyAudit(t.db, co.companyId, "allowance_rule.removed")).length, 2);
    assert.deepEqual(await listAllowanceRulesForAdmin(ctx, boss, vac), []);
  });

  test("the year rollover gives new rows from the rules", async () => {
    const { co, vac, dev } = await seed();
    const { boss, ana, bo } = co.people;
    await setAllowanceRule(createTestContext(t.db, { now: NOW }), boss, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 20 });
    await runYearRollover(createTestContext(t.db, { now: new Date("2027-01-02T12:00:00Z") }));
    const days = async (userId: string) => (await allowancesOf(t.db, userId)).find((a) => a.leaveTypeId === vac && a.year === 2027)?.days;
    assert.equal(await days(ana.id), 20);
    assert.equal(await days(bo.id), 15);
  });

  test("rules need a department or level of the company and days in tenths; only admins set them", async () => {
    const { co, ctx, vac, dev } = await seed();
    const other = await seedCompany(t.db, { stranger: { role: "admin" } });
    const otherDept = await createDepartment(createTestContext(t.db), other.people.stranger, "Elsewhere");
    const { boss, ana } = co.people;

    await rejectsWith(setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: null, levelId: null, days: 5 }), "invalid_input");
    await rejectsWith(setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 1.25 }), "invalid_input");
    await rejectsWith(setAllowanceRule(ctx, boss, { leaveTypeId: vac, departmentId: otherDept.id, levelId: null, days: 5 }), "not_found");
    await rejectsWith(setAllowanceRule(ctx, boss, { leaveTypeId: other.pto, departmentId: dev.id, levelId: null, days: 5 }), "not_found");
    await rejectsWith(setAllowanceRule(ctx, ana, { leaveTypeId: vac, departmentId: dev.id, levelId: null, days: 5 }), "forbidden");
    await rejectsWith(removeAllowanceRule(ctx, boss, ZERO_UUID), "not_found");
    assert.equal((await companyAudit(t.db, co.companyId, "allowance_rule.")).length, 0);
  });
});

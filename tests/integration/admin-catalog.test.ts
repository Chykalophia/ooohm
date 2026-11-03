import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getCompanySettings, updateCompanyAppearance, updateCompanySettings } from "@/server/services/admin-company";
import { getAppearance } from "@/server/services/appearance";
import { createDepartment, deleteDepartment, listDepartmentsForAdmin, renameDepartment } from "@/server/services/admin-departments";
import { addHoliday, addUsFederalHolidays, deleteHoliday, listHolidaysForAdmin, renameHoliday } from "@/server/services/admin-holidays";
import {
  createLeaveType,
  getLeaveTypeForAdmin,
  listLeaveTypesForAdmin,
  moveLeaveType,
  setLeaveTypeArchived,
  updateLeaveType,
} from "@/server/services/admin-leave-types";
import { getPersonDetail, getPersonFormOptions, listPeople } from "@/server/services/admin-people";
import { getBalanceSummary } from "@/server/services/balances";
import { getDashboard, submitLeaveRequest } from "@/server/services/leave-requests";
import { isUniqueViolation } from "@/server/repositories/errors";
import { rejectsWith } from "./assertions";
import { companyAudit, companyEvents, requestDaysOf, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

const ZERO_UUID = "00000000-0000-4000-8000-000000000000";

const leaveType = (over: Partial<Parameters<typeof createLeaveType>[2]> = {}) => ({
  name: "Parental leave",
  code: "par",
  color: "#7C3AED",
  isPaid: true,
  countsAgainstAllowance: true,
  defaultAllowanceDays: 10,
  carryoverEnabled: false,
  carryoverMaxDays: null,
  ...over,
});

describe("admin: departments, leave types, holidays and company", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("departments: create, rename and delete when empty, each audited; duplicates refused ignoring case", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
    const ctx = createTestContext(t.db);
    const { boss } = co.people;

    const ops = await createDepartment(ctx, boss, "  Ops ");
    assert.equal(ops.name, "Ops");
    await rejectsWith(createDepartment(ctx, boss, "OPS"), "already_exists");
    const renamed = await renameDepartment(ctx, boss, ops.id, "Operations");
    await renameDepartment(ctx, boss, ops.id, "Operations");
    assert.equal(renamed.name, "Operations");

    await t.db.update(schema.user).set({ departmentId: ops.id }).where(eq(schema.user.id, co.people.ana.id));
    await rejectsWith(deleteDepartment(ctx, boss, ops.id), "department_not_empty");
    assert.deepEqual((await listDepartmentsForAdmin(ctx, boss)).map((d) => [d.name, d.members]), [["Operations", 1]]);
    await t.db.update(schema.user).set({ departmentId: null }).where(eq(schema.user.id, co.people.ana.id));
    await deleteDepartment(ctx, boss, ops.id);
    assert.deepEqual(await listDepartmentsForAdmin(ctx, boss), []);

    const audit = await companyAudit(t.db, co.companyId);
    assert.deepEqual(
      audit.map((a) => [a.action, a.actorId, a.entityId, a.before, a.after]),
      [
        ["department.created", boss.id, ops.id, null, { name: "Ops" }],
        ["department.renamed", boss.id, ops.id, { name: "Ops" }, { name: "Operations" }],
        ["department.deleted", boss.id, ops.id, { name: "Operations" }, null],
      ],
    );
    assert.deepEqual(
      (await companyEvents(t.db, co.companyId)).map((e) => [e.type, e.payload]),
      [
        ["department.created", { departmentId: ops.id, name: "Ops", actorId: boss.id, actor: { type: "user", id: boss.id } }],
        ["department.renamed", { departmentId: ops.id, name: "Operations", actorId: boss.id, actor: { type: "user", id: boss.id } }],
        ["department.deleted", { departmentId: ops.id, name: "Operations", actorId: boss.id, actor: { type: "user", id: boss.id } }],
      ],
    );
  });

  test("departments: two creates racing past the read check cannot both win, whatever the case", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { boss } = co.people;
    const raced = await Promise.allSettled([createDepartment(ctx, boss, "Sales"), createDepartment(ctx, boss, "sales")]);
    assert.deepEqual(raced.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    await rejectsWith(Promise.reject((raced.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), "already_exists");
    await assert.rejects(
      t.db.insert(schema.departments).values({ companyId: co.companyId, name: "SALES" }),
      (err: unknown) => isUniqueViolation(err, "departments_company_lower_name_uq"),
      "the index itself ignores case",
    );
    assert.equal((await listDepartmentsForAdmin(ctx, boss)).length, 1);
    assert.equal((await companyAudit(t.db, co.companyId, "department.")).length, 1, "only the winner is audited");

    // Every department list and picker sorts the same way, ignoring case.
    for (const name of ["beta", "Alpha", "Gamma"]) await createDepartment(ctx, boss, name);
    const adminOrder = (await listDepartmentsForAdmin(ctx, boss)).map((d) => d.name.toLowerCase());
    assert.deepEqual(adminOrder, ["alpha", "beta", "gamma", "sales"]);
    assert.deepEqual((await getPersonFormOptions(ctx, boss, null)).departments.map((d) => d.name.toLowerCase()), adminOrder);
    assert.deepEqual((await listPeople(ctx, boss, { status: "all" })).departments.map((d) => d.name.toLowerCase()), adminOrder);
  });

  test("departments: non-admins are refused and another company's department is not found", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" } });
    const other = await seedCompany(t.db, { theirs: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const theirs = await createDepartment(ctx, other.people.theirs, "Theirs");
    await rejectsWith(createDepartment(ctx, co.people.mgr, "Sales"), "forbidden");
    await rejectsWith(listDepartmentsForAdmin(ctx, co.people.mgr), "forbidden");
    await rejectsWith(renameDepartment(ctx, co.people.boss, theirs.id, "Mine"), "not_found");
    await rejectsWith(deleteDepartment(ctx, co.people.boss, theirs.id), "not_found");
    await rejectsWith(deleteDepartment(ctx, co.people.boss, "not-a-uuid"), "not_found");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
  });

  test("leave types: create goes last with normalised settings; codes are unique per company", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const other = await seedCompany(t.db, { theirs: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { boss } = co.people;

    const created = await createLeaveType(ctx, boss, leaveType());
    assert.deepEqual(
      [created.code, created.color, created.defaultAllowanceDays, created.carryoverEnabled, created.archivedAt],
      ["PAR", "#7c3aed", 10, false, null],
    );
    assert.equal(created.sortOrder, 2, "after PTO (0) and the archived OLD (1)");
    await rejectsWith(createLeaveType(ctx, boss, leaveType({ code: "pto" })), "already_exists");
    await createLeaveType(ctx, other.people.theirs, leaveType());
    await rejectsWith(createLeaveType(ctx, boss, leaveType({ color: "teal" })), "invalid_input");
    await rejectsWith(createLeaveType(ctx, boss, leaveType({ defaultAllowanceDays: -1 })), "invalid_input");

    const [audit] = await companyAudit(t.db, co.companyId);
    assert.deepEqual([audit.action, audit.entityId, audit.before], ["leave_type.created", created.id, null]);
    const [event] = await companyEvents(t.db, co.companyId);
    assert.deepEqual(event.payload, {
      leaveTypeId: created.id,
      name: "Parental leave",
      code: "PAR",
      color: "#7c3aed",
      isPaid: true,
      countsAgainstAllowance: true,
      defaultAllowanceDays: 10,
      carryoverEnabled: false,
      carryoverMaxDays: null,
      sortOrder: 2,
      archived: false,
      actorId: boss.id,
      actor: { type: "user", id: boss.id },
    });
  });

  test("leave types: edit, archive (gone from the request form, still on history and balances), restore", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    const par = await createLeaveType(ctx, boss, leaveType({ defaultAllowanceDays: 5 }));
    await submitLeaveRequest(ctx, ana, { leaveTypeId: par.id, startDate: "2026-11-16", dayPortion: "full" });

    const edited = await updateLeaveType(ctx, boss, par.id, leaveType({ name: "Parental", code: "PL", defaultAllowanceDays: 8 }));
    assert.deepEqual([edited.name, edited.code, edited.defaultAllowanceDays], ["Parental", "PL", 8]);
    await updateLeaveType(ctx, boss, par.id, leaveType({ name: "Parental", code: "PL", defaultAllowanceDays: 8 }));
    await rejectsWith(updateLeaveType(ctx, boss, par.id, leaveType({ code: "PTO" })), "already_exists");

    const balanceOf = async () => (await getDashboard(ctx, ana)).balances?.items.find((i) => i.leaveTypeId === par.id)?.balance;
    assert.deepEqual(await balanceOf().then((b) => b?.tracked && b.remaining), 7, "the new default applies at once");

    await setLeaveTypeArchived(ctx, boss, par.id, true);
    await setLeaveTypeArchived(ctx, boss, par.id, true);
    const dash = await getDashboard(ctx, ana);
    assert.ok(!dash.leaveTypes.some((lt) => lt.id === par.id), "archived types leave the request form");
    assert.ok(dash.requests.some((r) => r.leaveTypeName === "Parental"), "history still names it");

    // Balances keep an archived type the person has days of, and drop one they never touched.
    const shown = (items: readonly { leaveTypeId: string; archived: boolean; balance: { used: number } }[] | undefined) =>
      Object.fromEntries((items ?? []).map((i) => [i.leaveTypeId, { archived: i.archived, used: i.balance.used }]));
    const dashboardBalances = shown(dash.balances?.items);
    assert.deepEqual(dashboardBalances[par.id], { archived: true, used: 1 }, "the archived type's booked day still shows");
    assert.equal(dashboardBalances[co.archived], undefined, "an archived type with no history stays hidden");
    assert.deepEqual(dashboardBalances[co.pto], { archived: false, used: 0 }, "active types always show");
    assert.deepEqual(shown((await getBalanceSummary(ctx, ana)).items), dashboardBalances);
    const detail = await getPersonDetail(ctx, boss, ana.id);
    assert.deepEqual(shown(detail.balances?.items), dashboardBalances, "the admin person page agrees with the dashboard");
    assert.ok(detail.leaveTypes.has(par.id), "the allowance editor still knows the archived type's settings");
    await rejectsWith(submitLeaveRequest(ctx, ana, { leaveTypeId: par.id, startDate: "2026-11-18", dayPortion: "full" }), "leave_type_unavailable");

    const restored = await setLeaveTypeArchived(ctx, boss, par.id, false);
    assert.equal(restored.archivedAt, null);
    assert.ok((await getDashboard(ctx, ana)).leaveTypes.some((lt) => lt.id === par.id));

    const actions = (await companyAudit(t.db, co.companyId, "leave_type.")).map((a) => a.action);
    assert.deepEqual(actions, ["leave_type.created", "leave_type.updated", "leave_type.archived", "leave_type.unarchived"]);
    assert.deepEqual((await companyEvents(t.db, co.companyId, "leave_type.")).map((e) => e.type), actions);
  });

  test("leave types: reorder moves one place and renumbers the active types, auditing each that moved", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const { boss } = co.people;
    const a = await createLeaveType(ctx, boss, leaveType({ code: "A", name: "A" }));
    const b = await createLeaveType(ctx, boss, leaveType({ code: "B", name: "B" }));
    const order = async () => (await listLeaveTypesForAdmin(ctx, boss)).map((lt) => `${lt.code}:${lt.sortOrder}${lt.archivedAt ? "x" : ""}`);
    assert.deepEqual(await order(), ["PTO:0", "A:2", "B:3", "OLD:1x"]);

    assert.equal(await moveLeaveType(ctx, boss, b.id, "up"), true);
    assert.deepEqual(await order(), ["PTO:0", "B:1", "A:2", "OLD:1x"]);
    assert.equal(await moveLeaveType(ctx, boss, co.pto, "up"), false, "already first");
    await rejectsWith(moveLeaveType(ctx, boss, co.archived, "up"), "not_found");
    const reordered = await companyAudit(t.db, co.companyId, "leave_type.reordered");
    assert.deepEqual(
      reordered.map((r) => [r.entityId, (r.before as { sortOrder: number }).sortOrder, (r.after as { sortOrder: number }).sortOrder]),
      [[b.id, 3, 1]],
      "A kept position 2; only B moved",
    );
    assert.equal(a.sortOrder, 2);
  });

  test("leave types: non-admins are refused, other companies' types are not found", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, emp: {} });
    const other = await seedCompany(t.db, { theirs: { role: "admin" } });
    const ctx = createTestContext(t.db);
    await rejectsWith(createLeaveType(ctx, co.people.emp, leaveType()), "forbidden");
    await rejectsWith(listLeaveTypesForAdmin(ctx, co.people.emp), "forbidden");
    await rejectsWith(getLeaveTypeForAdmin(ctx, co.people.boss, other.pto), "not_found");
    await rejectsWith(updateLeaveType(ctx, co.people.boss, other.pto, leaveType()), "not_found");
    await rejectsWith(setLeaveTypeArchived(ctx, co.people.boss, other.pto, true), "not_found");
    await rejectsWith(moveLeaveType(ctx, co.people.boss, other.pto, "down"), "not_found");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
  });

  test("holidays: add, rename, delete, each audited; a date holds one holiday; past requests keep their days", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    const request = await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-12-21", endDate: "2026-12-25", dayPortion: "full" });
    assert.deepEqual(await requestDaysOf(t.db, request.id), [{ year: 2026, days: 5 }]);

    const xmas = await addHoliday(ctx, boss, { date: "2026-12-25", name: " Christmas " });
    assert.equal(xmas.name, "Christmas");
    await rejectsWith(addHoliday(ctx, boss, { date: "2026-12-25", name: "Again" }), "already_exists");
    await rejectsWith(addHoliday(ctx, boss, { date: "2026-02-30", name: "Nope" }), "invalid_input");
    assert.deepEqual(await requestDaysOf(t.db, request.id), [{ year: 2026, days: 5 }], "the stored split never moves");

    await renameHoliday(ctx, boss, xmas.id, "Christmas Day");
    await deleteHoliday(ctx, boss, xmas.id);
    assert.deepEqual((await listHolidaysForAdmin(ctx, boss, 2026)).holidays.map((h) => h.date), ["2026-11-26"]);

    const audit = await companyAudit(t.db, co.companyId, "holiday.");
    assert.deepEqual(
      audit.map((a) => [a.action, a.before, a.after]),
      [
        ["holiday.created", null, { date: "2026-12-25", name: "Christmas" }],
        ["holiday.renamed", { date: "2026-12-25", name: "Christmas" }, { date: "2026-12-25", name: "Christmas Day" }],
        ["holiday.deleted", { date: "2026-12-25", name: "Christmas Day" }, null],
      ],
    );
    assert.deepEqual(
      (await companyEvents(t.db, co.companyId, "holiday.")).map((e) => e.payload),
      [
        { holidayId: xmas.id, date: "2026-12-25", name: "Christmas", actorId: boss.id, actor: { type: "user", id: boss.id } },
        { holidayId: xmas.id, date: "2026-12-25", name: "Christmas Day", actorId: boss.id, actor: { type: "user", id: boss.id } },
        { holidayId: xmas.id, date: "2026-12-25", name: "Christmas Day", actorId: boss.id, actor: { type: "user", id: boss.id } },
      ],
    );
  });

  test("holidays: the US federal set fills only free dates, and running it twice adds nothing", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    // The fixture already has 2026-11-26 ("Thanksgiving").
    const added = await addUsFederalHolidays(ctx, co.people.boss, 2026);
    assert.equal(added.length, 10);
    assert.deepEqual(await addUsFederalHolidays(ctx, co.people.boss, 2026), []);
    const { holidays: all, year } = await listHolidaysForAdmin(ctx, co.people.boss);
    assert.equal(year, 2026, "the current year in the company's zone");
    assert.equal(all.length, 11);
    assert.equal(all.find((h) => h.date === "2026-11-26")?.name, "Thanksgiving", "an existing holiday keeps its name");
    assert.equal((await companyAudit(t.db, co.companyId, "holiday.created")).length, 10);
    assert.equal((await companyEvents(t.db, co.companyId, "holiday.created")).length, 10);
  });

  test("holidays: non-admins are refused, other companies' holidays are not found", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, emp: {} });
    const other = await seedCompany(t.db, { theirs: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const theirs = await addHoliday(ctx, other.people.theirs, { date: "2026-12-24", name: "Eve" });
    await rejectsWith(addHoliday(ctx, co.people.emp, { date: "2026-12-24", name: "Eve" }), "forbidden");
    await rejectsWith(addUsFederalHolidays(ctx, co.people.emp, 2026), "forbidden");
    await rejectsWith(renameHoliday(ctx, co.people.boss, theirs.id, "Mine"), "not_found");
    await rejectsWith(deleteHoliday(ctx, co.people.boss, theirs.id), "not_found");
    await rejectsWith(deleteHoliday(ctx, co.people.boss, ZERO_UUID), "not_found");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
  });

  test("company settings: saved, audited, and used for counting from then on", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    const settings = await getCompanySettings(ctx, boss);
    assert.ok(settings.timeZones.includes("America/Chicago") && settings.timeZones.includes("UTC"));
    assert.deepEqual(settings.allowancePolicies, ["annual_calendar_year"]);

    const before = await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-11-16", endDate: "2026-11-22", dayPortion: "full" });
    const saved = await updateCompanySettings(ctx, boss, {
      name: " Acme  Inc ",
      timezone: "Europe/Warsaw",
      workingDays: [6, 1, 2, 3, 4, 5],
      allowancePolicy: "annual_calendar_year",
    });
    assert.deepEqual([saved.name, saved.timezone, saved.workingDays], ["Acme Inc", "Europe/Warsaw", [1, 2, 3, 4, 5, 6]]);
    await updateCompanySettings(ctx, boss, { name: "Acme Inc", timezone: "Europe/Warsaw", workingDays: [1, 2, 3, 4, 5, 6], allowancePolicy: "annual_calendar_year" });

    const after = await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-11-30", endDate: "2026-12-06", dayPortion: "full" });
    assert.deepEqual([before.days, after.days], [5, 6], "Saturdays count from now on; the earlier request keeps 5");

    const audit = await companyAudit(t.db, co.companyId, "company.");
    assert.equal(audit.length, 1, "saving the same settings records nothing");
    assert.deepEqual(audit[0].after, {
      name: "Acme Inc",
      timezone: "Europe/Warsaw",
      workingDays: [1, 2, 3, 4, 5, 6],
      allowancePolicy: "annual_calendar_year",
      deletionGrace: false,
      theme: "classic",
      accentColor: null,
      corners: "theme",
      requestStyle: "form",
      layout: "standard",
    });
    const [event] = await companyEvents(t.db, co.companyId, "company.");
    assert.equal((event.payload as { companyId: string }).companyId, co.companyId);
  });

  test("company settings: bad values and non-admins are refused, nothing written", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" } });
    const ctx = createTestContext(t.db);
    const good = { name: "Acme", timezone: "UTC", workingDays: [1, 2, 3, 4, 5], allowancePolicy: "annual_calendar_year" };
    await rejectsWith(updateCompanySettings(ctx, co.people.mgr, good), "forbidden");
    await rejectsWith(getCompanySettings(ctx, co.people.mgr), "forbidden");
    await rejectsWith(updateCompanySettings(ctx, co.people.boss, { ...good, timezone: "Mars/Base" }), "invalid_input");
    await rejectsWith(updateCompanySettings(ctx, co.people.boss, { ...good, workingDays: [] }), "invalid_input");
    await rejectsWith(updateCompanySettings(ctx, co.people.boss, { ...good, allowancePolicy: "monthly_accrual" }), "invalid_input");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
  });

  test("appearance: an admin changes the look for everyone, audited and announced once", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" } });
    const ctx = createTestContext(t.db);
    const boss = co.people.boss;
    assert.deepEqual(await getAppearance(ctx), { theme: "classic", accentColor: null, corners: "theme", requestStyle: "form", layout: "standard" });

    const saved = await updateCompanyAppearance(ctx, boss, { theme: "cobalt", accentColor: "#F2A900", corners: "square" });
    assert.deepEqual([saved.theme, saved.accentColor, saved.corners], ["cobalt", "#f2a900", "square"]);
    await updateCompanyAppearance(ctx, boss, { theme: "cobalt", accentColor: "#f2a900", corners: "square" });

    const audit = await companyAudit(t.db, co.companyId, "company.");
    assert.equal(audit.length, 1, "saving the same look records nothing");
    assert.equal(audit[0].actorId, boss.id);
    assert.deepEqual(
      [audit[0].before, audit[0].after].map((s) => {
        const value = s as { theme: string; accentColor: string | null; corners: string };
        return [value.theme, value.accentColor, value.corners];
      }),
      [["classic", null, "theme"], ["cobalt", "#f2a900", "square"]],
    );
    const events = await companyEvents(t.db, co.companyId, "company.");
    assert.equal(events.length, 1);
    assert.equal((events[0].payload as { accentColor: string }).accentColor, "#f2a900");

    const sentence = await updateCompanyAppearance(ctx, boss, { theme: "cobalt", accentColor: "#f2a900", corners: "square", requestStyle: "sentence" });
    assert.equal(sentence.requestStyle, "sentence");
    const compact = await updateCompanyAppearance(ctx, boss, { theme: "cobalt", accentColor: "#f2a900", corners: "square", requestStyle: "sentence", layout: "compact" });
    assert.equal(compact.layout, "compact");
    assert.equal(((await companyEvents(t.db, co.companyId, "company."))[1].payload as { requestStyle: string }).requestStyle, "sentence");

    const plain = await updateCompanyAppearance(ctx, boss, { theme: "plum", accentColor: "", corners: "theme" });
    assert.equal(plain.accentColor, null, "a blank accent goes back to the theme's own");
  });

  test("appearance: bad values and non-admins are refused, nothing written", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" } });
    const ctx = createTestContext(t.db);
    await rejectsWith(updateCompanyAppearance(ctx, co.people.mgr, { theme: "cobalt", corners: "theme" }), "forbidden");
    await rejectsWith(updateCompanyAppearance(ctx, co.people.boss, { theme: "neon", corners: "theme" }), "invalid_input");
    await rejectsWith(updateCompanyAppearance(ctx, co.people.boss, { theme: "cobalt", corners: "theme", accentColor: "blue" }), "invalid_input");
    await rejectsWith(updateCompanyAppearance(ctx, co.people.boss, { theme: "cobalt", corners: "theme", requestStyle: "wizard" }), "invalid_input");
    await rejectsWith(updateCompanyAppearance(ctx, co.people.boss, { theme: "cobalt", corners: "theme", layout: "sideways" }), "invalid_input");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
  });
});

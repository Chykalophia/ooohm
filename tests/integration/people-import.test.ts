import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import { CHANGE_PROCESSES } from "@/domain/change-source";
import { peopleImportSampleCsv } from "@/domain/people-import";
import { INVITE_SUBJECT } from "@/server/email/invite-email";
import { invitePerson } from "@/server/services/admin-people";
import { importPeople, PEOPLE_IMPORT_HOURLY_LIMIT, previewPeopleImport } from "@/server/services/admin-people-import";
import { submitLeaveRequest } from "@/server/services/leave-requests";
import { rejectsWith } from "./assertions";
import { companyAudit, companyEvents, seedCompany, setAllowance } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

async function peopleOf(db: Database, companyId: string) {
  const rows = await db.select().from(schema.user).where(eq(schema.user.companyId, companyId));
  return new Map(rows.map((r) => [r.email, r]));
}

async function departmentsOf(db: Database, companyId: string) {
  return db.select().from(schema.departments).where(eq(schema.departments.companyId, companyId));
}

describe("admin: people import from CSV", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("the preview reports what would happen and writes nothing", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" } });
    const ctx = createTestContext(t.db);
    const csv = [
      "email,name,role,department,manager_email",
      `new.one@example.com,New One,employee,Design,${co.people.mgr.email}`,
      `${co.people.mgr.email},Already Here,,,`,
      "broken,,,,",
    ].join("\n");

    const plan = await previewPeopleImport(ctx, co.people.boss, csv);

    assert.deepEqual([plan.adds, plan.skips, plan.errors], [1, 1, 1]);
    assert.deepEqual(plan.newDepartments, ["Design"]);
    const add = plan.rows.find((r) => r.status === "add");
    assert.ok(add?.status === "add");
    assert.deepEqual(add.person.manager, { kind: "member", id: co.people.mgr.id, email: co.people.mgr.email });

    assert.equal((await peopleOf(t.db, co.companyId)).size, 2);
    assert.equal((await departmentsOf(t.db, co.companyId)).length, 0);
    assert.equal((await companyAudit(t.db, co.companyId)).length, 0);
    assert.equal(ctx.deferred(), 0);
  });

  test("an import creates everyone in creation order, audited through the import, and invites them after commit", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    await t.db.insert(schema.departments).values({ companyId: co.companyId, name: "Engineering" });
    const ctx = createTestContext(t.db);
    const csv = [
      "email,name,role,department,manager_email,can_self_approve",
      "dev@example.com,Dev Person,employee,engineering,lead@example.com,no",
      "lead@example.com,Lead Person,manager,Engineering,,yes",
      "designer@example.com,Des Igner,,Design,lead@example.com,",
    ].join("\n");

    const result = await importPeople(ctx, co.people.boss, { csv, sendInvites: true });
    assert.deepEqual(result, { added: 3, skipped: 0, departmentsCreated: 1 });

    const people = await peopleOf(t.db, co.companyId);
    const depts = new Map((await departmentsOf(t.db, co.companyId)).map((d) => [d.name, d.id]));
    const lead = people.get("lead@example.com")!;
    const dev = people.get("dev@example.com")!;
    const designer = people.get("designer@example.com")!;
    assert.deepEqual([lead.role, lead.canSelfApprove, lead.managerId, lead.departmentId], ["manager", true, null, depts.get("Engineering")]);
    assert.deepEqual([dev.name, dev.role, dev.managerId, dev.departmentId, dev.isActive], ["Dev Person", "employee", lead.id, depts.get("Engineering"), true]);
    assert.deepEqual([designer.role, designer.managerId, designer.departmentId], ["employee", lead.id, depts.get("Design")]);

    const audit = await companyAudit(t.db, co.companyId);
    assert.deepEqual(
      audit.map((a) => a.action).sort(),
      ["department.created", "user.created", "user.created", "user.created"],
    );
    for (const row of audit) {
      assert.deepEqual([row.actorKind, row.actorId, row.actorVia], ["user", co.people.boss.id, CHANGE_PROCESSES.peopleImport]);
    }
    const events = await companyEvents(t.db, co.companyId, "user.created");
    assert.equal(events.length, 3);
    assert.deepEqual((events[0].payload as { actor: unknown }).actor, { type: "user", id: co.people.boss.id, via: CHANGE_PROCESSES.peopleImport });

    assert.equal(ctx.sent.length, 0);
    await ctx.settle();
    assert.deepEqual(ctx.signInLinks.sort(), ["designer@example.com", "dev@example.com", "lead@example.com"]);
    assert.ok(ctx.sent.every((m) => m.subject === INVITE_SUBJECT));
  });

  test("with invites off, people are created and no email or link is sent", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    await importPeople(ctx, co.people.boss, { csv: "email,name\nquiet@example.com,Quiet\n", sendInvites: false });
    await ctx.settle();
    assert.ok((await peopleOf(t.db, co.companyId)).has("quiet@example.com"));
    assert.deepEqual([ctx.sent.length, ctx.signInLinks.length], [0, 0]);
  });

  test("skips people who already have an account, here or in another company, and creates the rest", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, old: {} });
    const other = await seedCompany(t.db, { elsewhere: {} });
    const ctx = createTestContext(t.db);
    const csv = `email,name\n${co.people.old.email},Old\n${other.people.elsewhere.email},Else\nfresh@example.com,Fresh\n`;

    const result = await importPeople(ctx, co.people.boss, { csv, sendInvites: false });

    assert.deepEqual(result, { added: 1, skipped: 2, departmentsCreated: 0 });
    const [stranger] = await t.db.select().from(schema.user).where(eq(schema.user.email, other.people.elsewhere.email));
    assert.equal(stranger.companyId, other.companyId);
  });

  test("any row with a problem stops the whole import, and nothing is written", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const csv = "email,name,department\ngood@example.com,Good,New Dept\nbad,,\n";

    await rejectsWith(importPeople(ctx, co.people.boss, { csv, sendInvites: true }), "invalid_input");

    assert.equal((await peopleOf(t.db, co.companyId)).size, 1);
    assert.equal((await departmentsOf(t.db, co.companyId)).length, 0);
    assert.equal((await companyAudit(t.db, co.companyId)).length, 0);
    assert.equal(ctx.deferred(), 0);
  });

  test("only active admins can preview or import", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" }, exAdmin: { role: "admin", isActive: false } });
    const ctx = createTestContext(t.db);
    const csv = "email,name\nsomeone@example.com,Someone\n";
    await rejectsWith(previewPeopleImport(ctx, co.people.mgr, csv), "forbidden");
    await rejectsWith(importPeople(ctx, co.people.mgr, { csv, sendInvites: false }), "forbidden");
    await rejectsWith(importPeople(ctx, co.people.exAdmin, { csv, sendInvites: false }), "forbidden");
    assert.equal((await peopleOf(t.db, co.companyId)).size, 3);
  });

  test("imports are capped per admin per hour, and do not use up the single-invite limit", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const rows = (from: number, n: number) =>
      "email,name\n" + Array.from({ length: n }, (_, i) => `cap${from + i}@example.com,Cap ${from + i}`).join("\n");

    await importPeople(ctx, co.people.boss, { csv: rows(0, PEOPLE_IMPORT_HOURLY_LIMIT - 1), sendInvites: false });
    await rejectsWith(importPeople(ctx, co.people.boss, { csv: rows(1000, 2), sendInvites: false }), "rate_limited");

    // A single invite still goes through: the import's people are counted apart.
    await invitePerson(ctx, co.people.boss, {
      email: "single@example.com",
      name: "Single",
      departmentId: null,
      managerId: null,
      role: "employee",
      canSelfApprove: false,
    });
  });

  test("importing an admin hands them requests an only admin had routed to themself", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    await setAllowance(t.db, { userId: co.people.boss.id, leaveTypeId: co.pto, year: 2026, days: 20 });
    const request = await submitLeaveRequest(ctx, co.people.boss, { leaveTypeId: co.pto, startDate: "2026-11-16", dayPortion: "full" });
    assert.equal(request.approverId, co.people.boss.id);

    await importPeople(ctx, co.people.boss, { csv: "email,name,role\nsecond@example.com,Second,admin\n", sendInvites: false });

    const second = (await peopleOf(t.db, co.companyId)).get("second@example.com")!;
    const [after] = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, request.id));
    assert.equal(after.approverId, second.id);
  });

  test("the sample file imports cleanly into a fresh company", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const result = await importPeople(ctx, co.people.boss, { csv: peopleImportSampleCsv(), sendInvites: false });
    assert.ok(result.added > 0);
    assert.equal(result.skipped, 0);
  });
});

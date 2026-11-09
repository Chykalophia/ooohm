import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getCompanySettings, updateCompanySettings } from "@/server/services/admin-company";
import { cancelLeaveRequest, getDashboard, submitLeaveRequest } from "@/server/services/leave-requests";
import { rejectsWith } from "./assertions";
import { addLeaveType, auditFor, companyAudit, companyEvents, decidable, eventsFor, requestsOf, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

// Heads-up time off: an admin turns approval off for the whole company, so people tell
// the company they're off instead of asking. Dates: 2026-11-02 is a Monday.

const settingsOf = (company: { name: string; timezone: string; workingDays: number[]; allowancePolicy: string }) => ({
  name: company.name,
  timezone: company.timezone,
  workingDays: company.workingDays,
  allowancePolicy: company.allowancePolicy,
});

describe("heads-up time off (approval turned off)", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function headsUpCompany(people: Parameters<typeof seedCompany>[1]) {
    const co = await seedCompany(t.db, people);
    await t.db.update(schema.companies).set({ approvalMode: "heads_up" }).where(eq(schema.companies.id, co.companyId));
    return co;
  }

  test("a new company asks for approval until an admin turns it off", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const { company } = await getCompanySettings(createTestContext(t.db), co.people.boss);
    assert.equal(company.approvalMode, "required");
  });

  test("time off is booked as it's sent, decided by the person themself, and their manager is told", async () => {
    const co = await headsUpCompany({ manager: { role: "manager" }, ana: { managerKey: "manager" } });
    const now = new Date("2026-11-01T09:00:00Z");
    const ctx = createTestContext(t.db, { now });
    const { ana, manager } = co.people;

    const req = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: co.pto,
      startDate: "2026-11-02",
      endDate: "2026-11-04",
      dayPortion: "full",
      note: "Off to the coast",
    });
    assert.equal(req.status, "approved");
    assert.equal(req.approverId, ana.id, "nobody else decided it, so nobody else is named as its approver");
    assert.equal(req.decidedAt?.toISOString(), now.toISOString());

    // Audited and announced like any other approval, by the person who booked it.
    const audit = await auditFor(t.db, req.id);
    assert.deepEqual(audit.map((a) => [a.action, a.actorId]), [
      ["leave_request.requested", ana.id],
      ["leave_request.approved", ana.id],
    ]);
    assert.deepEqual((await eventsFor(t.db, co.companyId, req.id)).map((e) => e.type), ["leave.requested", "leave.approved"]);

    await ctx.settle();
    assert.deepEqual(ctx.sent.map((m) => [m.to, m.subject]), [
      [ana.email, "Your time off is booked"],
      [manager.email, "Ana is off Nov 2 to Nov 4"],
    ]);
    const told = ctx.sent[1];
    assert.match(told.text, /^Ana is taking PTO, Mon, Nov 2 to Wed, Nov 4, 2026: 3 days\. It's booked, so there's nothing you need to do\./);
    assert.match(told.text, /“Off to the coast”/);
    assert.doesNotMatch(told.text, /approve/i, "the manager isn't asked for anything");

    // Nothing waits on the manager.
    assert.equal((await decidable(ctx, manager)).total, 0);
  });

  test("with nobody to tell, the time off is still booked: approval off never blocks a request", async () => {
    const co = await headsUpCompany({ ana: {} });
    const ctx = createTestContext(t.db);
    const req = await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-03", dayPortion: "full" });
    assert.equal(req.status, "approved");
    await ctx.settle();
    assert.deepEqual(ctx.sent.map((m) => m.to), [co.people.ana.email]);
  });

  test("balances still hold: heads-up time off can't spend days that aren't there", async () => {
    const co = await headsUpCompany({ manager: { role: "manager" }, ana: { managerKey: "manager" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 1 });
    const ctx = createTestContext(t.db);
    await rejectsWith(
      submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: vac, startDate: "2026-11-02", endDate: "2026-11-03", dayPortion: "full" }),
      "insufficient_balance",
    );
    assert.deepEqual(await requestsOf(t.db, co.people.ana.id), []);
  });

  test("cancelling booked time off tells the manager too", async () => {
    const co = await headsUpCompany({ manager: { role: "manager" }, ana: { managerKey: "manager" } });
    const ctx = createTestContext(t.db);
    const req = await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-05", dayPortion: "full" });
    await ctx.settle();
    ctx.sent.length = 0;

    await cancelLeaveRequest(ctx, co.people.ana, req.id);
    await ctx.settle();
    assert.deepEqual(ctx.sent.map((m) => [m.to, m.subject]), [
      [co.people.ana.email, "Your time off request was cancelled"],
      [co.people.manager.email, "A time off request was cancelled"],
    ]);
  });

  test("Home knows approval is off, so its form can say 'book' instead of 'request'", async () => {
    const co = await headsUpCompany({ ana: {} });
    const dashboard = await getDashboard(createTestContext(t.db), co.people.ana);
    assert.equal(dashboard.approvalMode, "heads_up");
  });

  test("an admin turns approval off and on: audited, announced, and requests already waiting stay with their approver", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, manager: { role: "manager" }, ana: { managerKey: "manager" } });
    const ctx = createTestContext(t.db);
    const { boss, ana, manager } = co.people;
    const waiting = await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-11-09", dayPortion: "full" });
    assert.equal(waiting.status, "pending");

    const { company } = await getCompanySettings(ctx, boss);
    const saved = await updateCompanySettings(ctx, boss, { ...settingsOf(company), approvalMode: "heads_up" });
    assert.equal(saved.company.approvalMode, "heads_up");

    const [stillWaiting] = (await requestsOf(t.db, ana.id)).filter((r) => r.id === waiting.id);
    assert.equal(stillWaiting.status, "pending", "switching approval off decides nothing by itself");
    assert.equal(stillWaiting.approverId, manager.id);

    const booked = await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-11-10", dayPortion: "full" });
    assert.equal(booked.status, "approved");

    // Saving the form without the field (an older client) leaves the setting as it is.
    const kept = await updateCompanySettings(ctx, boss, settingsOf(saved.company));
    assert.equal(kept.company.approvalMode, "heads_up");

    await updateCompanySettings(ctx, boss, { ...settingsOf(saved.company), approvalMode: "required" });
    const asked = await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-11-11", dayPortion: "full" });
    assert.equal(asked.status, "pending");

    const audit = await companyAudit(t.db, co.companyId, "company.");
    assert.deepEqual(
      audit.map((a) => [(a.before as { approvalMode: string }).approvalMode, (a.after as { approvalMode: string }).approvalMode, a.actorId]),
      [
        ["required", "heads_up", boss.id],
        ["heads_up", "required", boss.id],
      ],
    );
    const events = await companyEvents(t.db, co.companyId, "company.");
    assert.deepEqual(events.map((e) => (e.payload as { approvalMode: string }).approvalMode), ["heads_up", "required"]);
  });

  test("only admins change it, and only to a known value", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, mgr: { role: "manager" } });
    const ctx = createTestContext(t.db);
    const { company } = await getCompanySettings(ctx, co.people.boss);
    await rejectsWith(updateCompanySettings(ctx, co.people.mgr, { ...settingsOf(company), approvalMode: "heads_up" }), "forbidden");
    await rejectsWith(updateCompanySettings(ctx, co.people.boss, { ...settingsOf(company), approvalMode: "notify" }), "invalid_input");
    assert.deepEqual(await companyAudit(t.db, co.companyId), []);
  });
});

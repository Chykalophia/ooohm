import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { isDomainError } from "@/domain/errors";
import { updateStatusIfCurrent } from "@/server/repositories/leave-requests";
import { decideLeaveRequest, getApprovalNav, listApprovalInbox } from "@/server/services/approvals";
import { cancelLeaveRequest, getDashboard, submitLeaveRequest } from "@/server/services/leave-requests";
import { rejectsWith } from "./assertions";
import { auditFor, eventsFor, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

describe("approvals: decide, inbox and navigation", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function pendingRequest(startDate = "2026-11-09") {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      manager: { role: "manager", managerKey: "boss" },
      ana: { managerKey: "manager" },
      bo: { managerKey: "manager" },
    });
    const ctx = createTestContext(t.db, { now: new Date("2026-11-03T09:00:00Z") });
    const req = await submitLeaveRequest(ctx, co.people.ana, {
      leaveTypeId: co.pto,
      startDate,
      endDate: "2026-11-10",
      dayPortion: "full",
      note: "Trip",
    });
    await ctx.settle();
    ctx.sent.length = 0;
    return { co, ctx, req };
  }

  test("approve and reject are mirror images: status, decision fields, audit, event and email", async () => {
    const approved = await pendingRequest();
    const a = await decideLeaveRequest(approved.ctx, approved.co.people.manager, {
      requestId: approved.req.id,
      decision: "approve",
      reason: "  Have fun  ",
    });
    const rejected = await pendingRequest();
    const r = await decideLeaveRequest(rejected.ctx, rejected.co.people.manager, {
      requestId: rejected.req.id,
      decision: "reject",
      reason: "Launch week",
    });

    assert.deepEqual([a.status, r.status], ["approved", "rejected"]);
    assert.deepEqual([a.decisionNote, r.decisionNote], ["Have fun", "Launch week"]);
    assert.equal(a.decidedAt?.toISOString(), "2026-11-03T09:00:00.000Z");
    assert.equal(r.decidedAt?.toISOString(), "2026-11-03T09:00:00.000Z");
    assert.equal(a.approverId, approved.co.people.manager.id);

    const aAudit = await auditFor(t.db, a.id);
    const rAudit = await auditFor(t.db, r.id);
    assert.deepEqual(aAudit.map((x) => x.action), ["leave_request.requested", "leave_request.approved"]);
    assert.deepEqual(rAudit.map((x) => x.action), ["leave_request.requested", "leave_request.rejected"]);
    assert.equal(aAudit[1].actorId, approved.co.people.manager.id);
    assert.deepEqual(
      [(aAudit[1].before as { status: string }).status, (aAudit[1].after as { status: string }).status],
      ["pending", "approved"],
    );

    const aEvents = await eventsFor(t.db, approved.co.companyId, a.id);
    const rEvents = await eventsFor(t.db, rejected.co.companyId, r.id);
    assert.deepEqual(aEvents.map((e) => e.type), ["leave.requested", "leave.approved"]);
    assert.deepEqual(rEvents.map((e) => e.type), ["leave.requested", "leave.rejected"]);
    assert.deepEqual(aEvents[1].payload, {
      requestId: a.id,
      userId: approved.co.people.ana.id,
      leaveTypeId: approved.co.pto,
      startDate: "2026-11-09",
      endDate: "2026-11-10",
      dayPortion: "full",
      days: 2,
      status: "approved",
      actorId: approved.co.people.manager.id,
      actor: { type: "user", id: approved.co.people.manager.id },
    });

    await approved.ctx.settle();
    await rejected.ctx.settle();
    assert.deepEqual(approved.ctx.sent.map((m) => [m.to, m.subject]), [[approved.co.people.ana.email, "Your time off is approved"]]);
    assert.deepEqual(rejected.ctx.sent.map((m) => [m.to, m.subject]), [
      [rejected.co.people.ana.email, "Your time off request was declined"],
    ]);
    assert.match(rejected.ctx.sent[0].text, /Reason: Launch week/);
    assert.match(approved.ctx.sent[0].text, /Note from approver: Have fun/);

    // Both outcomes reach the requester's dashboard too.
    const [aDash, rDash] = await Promise.all([
      getDashboard(approved.ctx, approved.co.people.ana),
      getDashboard(rejected.ctx, rejected.co.people.ana),
    ]);
    assert.deepEqual(
      [aDash.requests[0].decisionNote, rDash.requests[0].decisionNote],
      ["Have fun", "Launch week"],
    );
  });

  test("an admin may decide any request in the company; others may not; nobody decides their own", async () => {
    const { co, ctx, req } = await pendingRequest();
    const outsider = await seedCompany(t.db, { x: { role: "admin" } });

    await rejectsWith(decideLeaveRequest(ctx, co.people.bo, { requestId: req.id, decision: "approve" }), "forbidden");
    await rejectsWith(decideLeaveRequest(ctx, co.people.ana, { requestId: req.id, decision: "approve" }), "forbidden");
    await rejectsWith(decideLeaveRequest(ctx, outsider.people.x, { requestId: req.id, decision: "approve" }), "not_found");
    await rejectsWith(decideLeaveRequest(ctx, co.people.boss, { requestId: "x", decision: "approve" }), "not_found");
    await rejectsWith(
      decideLeaveRequest(ctx, co.people.boss, { requestId: req.id, decision: "approve", reason: "x".repeat(501) }),
      "invalid_input",
    );
    assert.deepEqual((await auditFor(t.db, req.id)).map((a) => a.action), ["leave_request.requested"]);

    const decided = await decideLeaveRequest(ctx, co.people.boss, { requestId: req.id, decision: "reject" });
    assert.equal(decided.status, "rejected");
    assert.equal((await auditFor(t.db, req.id))[1].actorId, co.people.boss.id);
  });

  test("a company's only admin can approve the request routed to themself", async () => {
    const solo = await seedCompany(t.db, { boss: { role: "admin" } });
    const ctx = createTestContext(t.db);
    const req = await submitLeaveRequest(ctx, solo.people.boss, { leaveTypeId: solo.pto, startDate: "2026-11-03", dayPortion: "full" });
    assert.deepEqual((await listApprovalInbox(ctx, solo.people.boss)).items.map((r) => r.id), [req.id]);
    const approved = await decideLeaveRequest(ctx, solo.people.boss, { requestId: req.id, decision: "approve" });
    assert.equal(approved.status, "approved");
  });

  test("once demoted, a former sole admin can no longer see or decide the request routed to themself", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, later: { role: "employee" } });
    const ctx = createTestContext(t.db);
    const req = await submitLeaveRequest(ctx, co.people.boss, { leaveTypeId: co.pto, startDate: "2026-11-03", dayPortion: "full" });
    assert.equal(req.approverId, co.people.boss.id);

    // A second admin arrives and the first steps down; the stored approver is unchanged.
    await t.db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, co.people.later.id));
    await t.db.update(schema.user).set({ role: "employee" }).where(eq(schema.user.id, co.people.boss.id));
    const demoted = { ...co.people.boss, role: "employee" as const };
    const newAdmin = { ...co.people.later, role: "admin" as const };

    assert.deepEqual((await listApprovalInbox(ctx, demoted)).items, []);
    assert.deepEqual(await getApprovalNav(ctx, demoted), { visible: false, pending: 0 });
    await rejectsWith(decideLeaveRequest(ctx, demoted, { requestId: req.id, decision: "approve" }), "forbidden");
    assert.deepEqual((await auditFor(t.db, req.id)).map((a) => a.action), ["leave_request.requested"]);

    assert.deepEqual((await listApprovalInbox(ctx, newAdmin)).items.map((r) => r.id), [req.id]);
    const approved = await decideLeaveRequest(ctx, newAdmin, { requestId: req.id, decision: "approve" });
    assert.equal(approved.status, "approved");
  });

  test("a stored assignment the approval rule no longer backs grants nothing; an admin still decides", async () => {
    // A submit racing an admin edit can leave a request with an approver the edit was
    // meant to remove, since nothing re-routes it. Simulated with raw writes.
    const { co, ctx, req } = await pendingRequest();
    assert.equal(req.approverId, co.people.manager.id);
    await t.db.update(schema.user).set({ managerId: null }).where(eq(schema.user.id, co.people.ana.id));
    await rejectsWith(decideLeaveRequest(ctx, co.people.manager, { requestId: req.id, decision: "approve" }), "forbidden");
    assert.deepEqual((await auditFor(t.db, req.id)).map((a) => a.action), ["leave_request.requested"]);

    // Its pair: put the manager back and the same assignment decides again.
    await t.db.update(schema.user).set({ managerId: co.people.manager.id }).where(eq(schema.user.id, co.people.ana.id));
    const approved = await decideLeaveRequest(ctx, co.people.manager, { requestId: req.id, decision: "approve" });
    assert.equal(approved.status, "approved");
  });

  test("an admin demoted while a request was being routed to them cannot decide it", async () => {
    const co = await seedCompany(t.db, {
      a1: { role: "admin", createdAt: "2025-01-01T00:00:00Z" },
      a2: { role: "admin", createdAt: "2026-01-01T00:00:00Z" },
      emp: {},
    });
    const ctx = createTestContext(t.db, { now: new Date("2026-11-03T09:00:00Z") });
    const req = await submitLeaveRequest(ctx, co.people.emp, { leaveTypeId: co.pto, startDate: "2026-11-09", dayPortion: "full" });
    assert.equal(req.approverId, co.people.a1.id);
    // The demotion committed without seeing the request (no re-route ran).
    await t.db.update(schema.user).set({ role: "employee" }).where(eq(schema.user.id, co.people.a1.id));
    const demoted = { ...co.people.a1, role: "employee" as const };
    await rejectsWith(decideLeaveRequest(ctx, demoted, { requestId: req.id, decision: "approve" }), "forbidden");
    const decided = await decideLeaveRequest(ctx, co.people.a2, { requestId: req.id, decision: "reject" });
    assert.equal(decided.status, "rejected");
  });

  test("a decision resting on the assignment loses to a concurrent reassignment", async () => {
    const { co, req } = await pendingRequest();
    const where = { companyId: co.companyId, id: req.id, from: "pending" as const };
    const lost = await updateStatusIfCurrent(t.db, { ...where, approverId: co.people.boss.id }, { status: "approved" });
    assert.equal(lost, undefined, "assigned to the manager, not the boss");
    const won = await updateStatusIfCurrent(t.db, { ...where, approverId: co.people.manager.id }, { status: "approved" });
    assert.equal(won?.status, "approved");
  });

  test("decided, cancelled and approved-then-cancelled requests cannot be decided", async () => {
    const { co, ctx, req } = await pendingRequest();
    await decideLeaveRequest(ctx, co.people.manager, { requestId: req.id, decision: "approve" });
    await rejectsWith(decideLeaveRequest(ctx, co.people.manager, { requestId: req.id, decision: "reject" }), "invalid_transition");
    await rejectsWith(decideLeaveRequest(ctx, co.people.manager, { requestId: req.id, decision: "approve" }), "invalid_transition");

    // Cancelling after approval tells the approver too.
    await ctx.settle();
    ctx.sent.length = 0;
    await cancelLeaveRequest(ctx, co.people.ana, req.id);
    await ctx.settle();
    assert.deepEqual(ctx.sent.map((m) => m.to).sort(), [co.people.ana.email, co.people.manager.email].sort());
    await rejectsWith(decideLeaveRequest(ctx, co.people.manager, { requestId: req.id, decision: "approve" }), "invalid_transition");
    assert.deepEqual((await auditFor(t.db, req.id)).map((a) => a.action), [
      "leave_request.requested",
      "leave_request.approved",
      "leave_request.cancelled",
    ]);
  });

  test("concurrent decisions on one request: exactly one wins and only it is recorded", async () => {
    const { co, ctx, req } = await pendingRequest();
    const results = await Promise.allSettled([
      decideLeaveRequest(ctx, co.people.manager, { requestId: req.id, decision: "approve" }),
      decideLeaveRequest(ctx, co.people.boss, { requestId: req.id, decision: "reject" }),
      decideLeaveRequest(ctx, co.people.manager, { requestId: req.id, decision: "reject" }),
      decideLeaveRequest(ctx, co.people.boss, { requestId: req.id, decision: "approve" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(won.length, 1);
    for (const l of lost) {
      assert.ok(isDomainError(l.reason, "conflict") || isDomainError(l.reason, "invalid_transition"), String(l.reason));
    }
    const events = await eventsFor(t.db, co.companyId, req.id);
    assert.equal(events.length, 2, "one requested event plus exactly one decision");
    assert.equal((await auditFor(t.db, req.id)).length, 2);
  });

  test("the inbox shows what each person may decide", async () => {
    const { co, ctx, req } = await pendingRequest();
    const boReq = await submitLeaveRequest(ctx, co.people.bo, { leaveTypeId: co.pto, startDate: "2026-11-16", dayPortion: "full" });
    const mgrReq = await submitLeaveRequest(ctx, co.people.manager, { leaveTypeId: co.pto, startDate: "2026-11-17", dayPortion: "full" });

    const ids = async (who: keyof typeof co.people) => (await listApprovalInbox(ctx, co.people[who])).items.map((r) => r.id).sort();
    assert.deepEqual(await ids("manager"), [req.id, boReq.id].sort(), "manager: their reports, not their own request");
    assert.deepEqual(await ids("boss"), [req.id, boReq.id, mgrReq.id].sort(), "admin: every pending request");
    assert.deepEqual(await ids("ana"), []);

    await decideLeaveRequest(ctx, co.people.manager, { requestId: req.id, decision: "approve" });
    assert.deepEqual(await ids("manager"), [boReq.id]);

    const { items: inbox, total } = await listApprovalInbox(ctx, co.people.manager);
    assert.equal(total, 1);
    assert.equal(inbox[0].requesterName, "Bo");
    assert.equal(inbox[0].leaveTypeName, "PTO");

    // An admin can tell which requests are routed to someone else.
    const { items: adminInbox } = await listApprovalInbox(ctx, co.people.boss);
    assert.deepEqual(
      adminInbox.map((r) => [r.id, r.approverName]).sort(),
      [
        [boReq.id, "Manager"],
        [mgrReq.id, "Boss"],
      ].sort(),
    );
  });

  test("a cut inbox reports the full count, which matches the header's", async () => {
    const { co, ctx } = await pendingRequest();
    await submitLeaveRequest(ctx, co.people.bo, { leaveTypeId: co.pto, startDate: "2026-11-16", dayPortion: "full" });
    await submitLeaveRequest(ctx, co.people.bo, { leaveTypeId: co.pto, startDate: "2026-11-17", dayPortion: "full" });

    const cut = await listApprovalInbox(ctx, co.people.manager, 2);
    assert.deepEqual([cut.items.length, cut.total], [2, 3]);
    assert.deepEqual(cut.items.map((r) => r.startDate), ["2026-11-09", "2026-11-16"], "earliest dates first");
    const whole = await listApprovalInbox(ctx, co.people.manager, 3);
    assert.deepEqual([whole.items.length, whole.total], [3, 3]);
    assert.equal((await getApprovalNav(ctx, co.people.manager)).pending, cut.total);
  });

  test("the Approvals link shows for managers and admins, and for anyone with something assigned", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      lead: { role: "employee" },
      ana: { managerKey: "lead" },
      bo: {},
      manager: { role: "manager" },
    });
    const ctx = createTestContext(t.db);

    assert.deepEqual(await getApprovalNav(ctx, co.people.lead), { visible: false, pending: 0 });
    assert.deepEqual(await getApprovalNav(ctx, co.people.bo), { visible: false, pending: 0 });
    assert.deepEqual(await getApprovalNav(ctx, co.people.manager), { visible: true, pending: 0 });

    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-18", dayPortion: "full" });
    assert.deepEqual(await getApprovalNav(ctx, co.people.lead), { visible: true, pending: 1 });
    assert.deepEqual(await getApprovalNav(ctx, co.people.bo), { visible: false, pending: 0 });
    assert.deepEqual(await getApprovalNav(ctx, co.people.boss), { visible: true, pending: 1 });
  });
});

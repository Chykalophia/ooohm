import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { decideLeaveRequest } from "@/server/services/approvals";
import { approveFromEmail, approveLinkFor, readEmailApproval } from "@/server/services/email-approval";
import { getDashboard, submitLeaveRequest } from "@/server/services/leave-requests";
import { auditFor, eventsFor, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

describe("approve from the email", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const NOW = new Date("2026-11-03T09:00:00Z");

  async function requested() {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      manager: { role: "manager", managerKey: "boss" },
      ana: { managerKey: "manager" },
    });
    const ctx = createTestContext(t.db, { now: NOW });
    const req = await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-09", dayPortion: "full", note: "Trip" });
    await ctx.settle();
    const mail = ctx.sent.find((m) => m.subject === "Time off request to review");
    assert.ok(mail, "the approver got the request email");
    const link = mail.text.match(/^Approve: (\S+)$/m)?.[1] ?? "";
    assert.ok(link?.startsWith("https://ooohm.test/approve/"), String(link));
    const token = link.slice("https://ooohm.test/approve/".length);
    return { co, ctx, req, token };
  }

  test("the link approves once, as the approver through the link, after a look that changes nothing", async () => {
    const { co, ctx, req, token } = await requested();

    const look = await readEmailApproval(ctx, token);
    assert.equal(look.state, "ready");
    assert.equal(look.state === "ready" && look.request.note, "Trip");
    assert.equal((await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, req.id)))[0].status, "pending");

    const done = await approveFromEmail(ctx, token);
    assert.equal(done.state, "approved");
    const audit = await auditFor(t.db, req.id);
    assert.deepEqual(
      audit.map((a) => [a.action, a.actorId, a.actorVia]),
      [
        ["leave_request.requested", co.people.ana.id, null],
        ["leave_request.approved", co.people.manager.id, "email_link"],
      ],
    );
    const events = await eventsFor(t.db, co.companyId, req.id);
    assert.deepEqual((events[1].payload as { actor: unknown }).actor, { type: "user", id: co.people.manager.id, via: "email_link" });

    assert.equal((await approveFromEmail(ctx, token)).state, "decided", "a second press changes nothing");
    assert.equal((await readEmailApproval(ctx, token)).state, "decided");
    assert.equal((await auditFor(t.db, req.id)).length, 2);
  });

  test("expired, tampered, moved and deactivated links do nothing", async () => {
    const { co, req, token } = await requested();
    const later = createTestContext(t.db, { now: new Date(NOW.getTime() + 8 * 86_400_000) });
    assert.equal((await approveFromEmail(later, token)).state, "expired");

    const ctx = createTestContext(t.db, { now: NOW });
    const [body, sig] = token.split(".");
    assert.equal((await approveFromEmail(ctx, `${body}.${sig.slice(1)}x`)).state, "invalid");
    assert.equal((await approveFromEmail(ctx, "nonsense")).state, "invalid");
    assert.equal((await approveFromEmail({ ...ctx, linkKey: undefined }, token)).state, "invalid", "nothing to check it with");

    // Routed to someone else since: the manager may no longer decide it.
    await t.db.update(schema.leaveRequests).set({ approverId: co.people.boss.id }).where(eq(schema.leaveRequests.id, req.id));
    assert.equal((await readEmailApproval(ctx, token)).state, "not_yours");
    assert.equal((await approveFromEmail(ctx, token)).state, "not_yours");
    // An admin's link is bound the same way: once the request is the manager's again, the boss's link stops working.
    const bossToken = (approveLinkFor(ctx, req.id, co.people.boss.id) ?? "").split("/approve/")[1] ?? "";
    assert.equal((await readEmailApproval(ctx, bossToken)).state, "ready");
    await t.db.update(schema.leaveRequests).set({ approverId: co.people.manager.id }).where(eq(schema.leaveRequests.id, req.id));
    assert.equal((await readEmailApproval(ctx, bossToken)).state, "not_yours");
    assert.equal((await approveFromEmail(ctx, bossToken)).state, "not_yours");
    await assert.rejects(
      decideLeaveRequest(ctx, co.people.boss, { requestId: req.id, decision: "approve", assignedTo: co.people.boss.id }),
      (err: unknown) => (err as { code?: string }).code === "forbidden",
      "the decision itself checks the assignment",
    );

    await t.db.update(schema.user).set({ isActive: false }).where(eq(schema.user.id, co.people.manager.id));
    assert.equal((await approveFromEmail(ctx, token)).state, "not_yours");
    const [row] = await t.db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, req.id));
    assert.equal(row.status, "pending");
  });

  test("a self-approved request sends no approve link", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss", canSelfApprove: true } });
    const ctx = createTestContext(t.db, { now: NOW });
    await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-09", dayPortion: "full" });
    await ctx.settle();
    assert.equal(ctx.sent.filter((m) => /Approve: /.test(m.text)).length, 0);
  });

  test("a pending request shows how long its approver usually takes, once there are three decisions", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, manager: { role: "manager", managerKey: "boss" }, ana: { managerKey: "manager" } });
    const submitAt = (iso: string) => createTestContext(t.db, { now: new Date(iso) });
    const hours = [2, 5, 30];
    const pending = await submitLeaveRequest(createTestContext(t.db, { now: NOW }), co.people.ana, {
      leaveTypeId: co.pto,
      startDate: "2026-11-16",
      dayPortion: "full",
    });
    for (const [i, h] of hours.entries()) {
      const start = `2026-10-${String(5 + i).padStart(2, "0")}`;
      const req = await submitLeaveRequest(submitAt("2026-10-01T09:00:00Z"), co.people.ana, {
        leaveTypeId: co.pto,
        startDate: start,
        dayPortion: "full",
      });
      await t.db
        .update(schema.leaveRequests)
        .set({ createdAt: new Date("2026-10-01T09:00:00Z") })
        .where(eq(schema.leaveRequests.id, req.id));
      await decideLeaveRequest(createTestContext(t.db, { now: new Date(Date.parse("2026-10-01T09:00:00Z") + h * 3_600_000) }), co.people.manager, {
        requestId: req.id,
        decision: "approve",
      });
      if (i === 1) {
        const dash = await getDashboard(createTestContext(t.db, { now: NOW }), co.people.ana);
        assert.equal(dash.requests.find((r) => r.id === pending.id)?.typicalWaitHours, null, "two decisions are not enough to say");
      }
    }
    const dash = await getDashboard(createTestContext(t.db, { now: NOW }), co.people.ana);
    const row = dash.requests.find((r) => r.id === pending.id);
    assert.equal(row?.typicalWaitHours, 5, "the median of 2, 5 and 30 hours");
    assert.ok(dash.requests.filter((r) => r.status !== "pending").every((r) => r.typicalWaitHours === null));
  });
});

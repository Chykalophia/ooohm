import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { isDomainError } from "@/domain/errors";
import { cancelLeaveRequest } from "@/server/services/leave-requests";
import { addLeaveFor, previewLeaveFor } from "@/server/services/leave-on-behalf";
import { getTeamMember } from "@/server/services/team-member";
import { rejectsWith } from "./assertions";
import { addLeaveType, auditFor, eventsFor, requestsOf, seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

// Dates: 2026-11-02 is a Monday; 2026-11-26 (Thu) is the seeded holiday.
const now = new Date("2026-11-01T12:00:00Z");
const week = { startDate: "2026-11-23", endDate: "2026-11-27", dayPortion: "full" as const };

describe("leave requests: added for someone by a manager or admin", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const seed = () =>
    seedCompany(t.db, {
      boss: { role: "admin" },
      mo: { role: "manager", managerKey: "boss" },
      ana: { managerKey: "mo" },
      bo: { managerKey: "boss" },
    });

  test("a manager adds time off for a direct report: approved at once, audited as theirs, the person emailed", async () => {
    const co = await seed();
    const ctx = createTestContext(t.db, { now });
    const { mo, ana } = co.people;

    const req = await addLeaveFor(ctx, mo, ana.id, { leaveTypeId: co.pto, ...week, note: " Called in sick " });
    assert.equal(req.userId, ana.id);
    assert.equal(req.status, "approved");
    assert.equal(req.approverId, mo.id);
    assert.equal(req.days, 4, "counted like her own request: Thanksgiving is free");
    assert.equal(req.note, "Called in sick");
    assert.deepEqual(req.decidedAt, now);
    assert.equal(req.personName, "Ana");

    const audit = await auditFor(t.db, req.id);
    assert.deepEqual(
      audit.map((a) => [a.action, a.actorId, a.subjectUserId]),
      [
        ["leave_request.requested", mo.id, ana.id],
        ["leave_request.approved", mo.id, ana.id],
      ],
    );
    const events = await eventsFor(t.db, co.companyId, req.id);
    assert.deepEqual(events.map((e) => [e.type, (e.payload as { actorId: string }).actorId]), [
      ["leave.requested", mo.id],
      ["leave.approved", mo.id],
    ]);

    await ctx.settle();
    assert.deepEqual(ctx.sent.map((m) => [m.to, m.subject]), [[ana.email, "Time off was added for you"]]);
    assert.match(ctx.sent[0].text, /^Mo added your \S+, Mon, Nov 23 to Fri, Nov 27, 2026: 4 days\. It's approved/);
    assert.match(ctx.sent[0].text, /Note: “Called in sick”/);

    // It is hers: she can cancel it like any request of her own.
    const cancelled = await cancelLeaveRequest(ctx, ana, req.id);
    assert.equal(cancelled.status, "cancelled");
  });

  test("an admin adds for anyone; nobody adds for themself, a peer, or someone else's report", async () => {
    const co = await seed();
    const ctx = createTestContext(t.db, { now });
    const { boss, mo, ana, bo } = co.people;
    const draft = { leaveTypeId: co.pto, ...week };

    const byAdmin = await addLeaveFor(ctx, boss, ana.id, draft);
    assert.equal(byAdmin.status, "approved");
    assert.equal(byAdmin.approverId, boss.id);

    await rejectsWith(addLeaveFor(ctx, mo, mo.id, draft), "forbidden");
    await rejectsWith(addLeaveFor(ctx, boss, boss.id, draft), "forbidden");
    await rejectsWith(addLeaveFor(ctx, mo, bo.id, draft), "forbidden");
    await rejectsWith(addLeaveFor(ctx, ana, mo.id, draft), "forbidden");
    await rejectsWith(addLeaveFor(ctx, boss, "not-a-uuid", draft), "not_found");
    await rejectsWith(previewLeaveFor(ctx, mo, bo.id, draft), "forbidden");
    assert.equal((await requestsOf(t.db, bo.id)).length, 0);
  });

  test("the person's own rules apply: overlaps, inactive people, and their balance", async () => {
    const co = await seed();
    const ctx = createTestContext(t.db, { now });
    const { boss, mo, ana } = co.people;

    await addLeaveFor(ctx, mo, ana.id, { leaveTypeId: co.pto, ...week });
    await rejectsWith(addLeaveFor(ctx, boss, ana.id, { leaveTypeId: co.pto, ...week, startDate: "2026-11-27" }), "overlapping_request");

    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 2 });
    const preview = await previewLeaveFor(ctx, boss, ana.id, { leaveTypeId: vac, startDate: "2026-11-02", endDate: "", dayPortion: "full" });
    assert.deepEqual(preview, { cost: { days: 1, years: [{ year: 2026, days: 1, remainingAfter: 1 }] }, personName: "Ana" });

    const tooMany = { leaveTypeId: vac, startDate: "2026-11-02", endDate: "2026-11-04", dayPortion: "full" as const };
    await assert.rejects(addLeaveFor(ctx, boss, ana.id, tooMany), (err) => {
      assert.ok(isDomainError(err, "insufficient_balance"));
      assert.deepEqual(err.details, { year: 2026, requested: 3, remaining: 2, yearsSpanned: 1, person: "Ana" });
      return true;
    });

    await t.db.update(schema.user).set({ isActive: false }).where(eq(schema.user.id, ana.id));
    await rejectsWith(addLeaveFor(ctx, mo, ana.id, { leaveTypeId: co.pto, startDate: "2026-12-01", endDate: "", dayPortion: "full" }), "not_found");
  });

  test("a manager who may not see balances is never told what is left", async () => {
    const co = await seed();
    const ctx = createTestContext(t.db, { now });
    const { mo, ana } = co.people;
    await t.db.update(schema.companies).set({ managersSeeDetails: false }).where(eq(schema.companies.id, co.companyId));
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 2 });

    const preview = await previewLeaveFor(ctx, mo, ana.id, { leaveTypeId: vac, startDate: "2026-11-02", endDate: "", dayPortion: "full" });
    assert.equal(preview.cost.years[0].remainingAfter, null);

    const tooMany = { leaveTypeId: vac, startDate: "2026-11-02", endDate: "2026-11-04", dayPortion: "full" as const };
    await assert.rejects(addLeaveFor(ctx, mo, ana.id, tooMany), (err) => {
      assert.ok(isDomainError(err, "insufficient_balance"));
      assert.equal(err.details, undefined);
      return true;
    });
  });

  test("the team page offers the form only to an admin or the person's manager", async () => {
    const co = await seed();
    const ctx = createTestContext(t.db, { now });
    const { boss, mo, ana, bo } = co.people;

    const forManager = await getTeamMember(ctx, mo, ana.id);
    assert.equal(forManager.addLeave?.leaveTypes.map((l) => l.name).join(), "PTO", "active types only");
    assert.equal(forManager.addLeave?.defaultDate, "2026-11-02");
    assert.ok((await getTeamMember(ctx, boss, bo.id)).addLeave);
    assert.equal((await getTeamMember(ctx, mo, bo.id)).addLeave, null);
    assert.equal((await getTeamMember(ctx, ana, mo.id)).addLeave, null);
    assert.equal((await getTeamMember(ctx, mo, mo.id)).addLeave, null);
  });
});

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { isDomainError } from "@/domain/errors";
import { cancelLeaveRequest, getDashboard } from "@/server/services/leave-requests";
import { addLeaveFor, previewLeaveFor, removeLeaveFor } from "@/server/services/leave-on-behalf";
import { runYearRollover } from "@/server/services/rollover";
import { getTeamMember } from "@/server/services/team-member";
import { rejectsWith } from "./assertions";
import { addLeaveType, allowancesOf, auditFor, companyAudit, eventsFor, requestsOf, seedCompany, setAllowance } from "./fixtures";
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

  describe("past time off: over for the person, correctable by their manager or an admin", () => {
    // Mon Oct 5 to Tue Oct 6 2026: approved and over by Nov 1.
    const october = { startDate: "2026-10-05", endDate: "2026-10-06", dayPortion: "full" as const };
    const inOctober = new Date("2026-09-28T12:00:00Z");

    const pastLeaveOf = async (co: Awaited<ReturnType<typeof seed>>) => {
      const then = createTestContext(t.db, { now: inOctober });
      const req = await addLeaveFor(then, co.people.mo, co.people.ana.id, { leaveTypeId: co.pto, ...october });
      await then.settle();
      return req;
    };

    test("the person can no longer cancel approved time off that is over, and sees no Cancel", async () => {
      const co = await seed();
      const ctx = createTestContext(t.db, { now });
      const req = await pastLeaveOf(co);
      assert.equal((await getDashboard(ctx, co.people.ana)).requests.find((r) => r.id === req.id)?.cancellable, false);
      await rejectsWith(cancelLeaveRequest(ctx, co.people.ana, req.id), "leave_taken");
      assert.equal((await requestsOf(t.db, co.people.ana.id))[0].status, "approved");
    });

    test("their manager removes it with a reason: cancelled, audited and announced as theirs, the person emailed", async () => {
      const co = await seed();
      const ctx = createTestContext(t.db, { now });
      const { mo, ana } = co.people;
      const req = await pastLeaveOf(co);

      const removed = await removeLeaveFor(ctx, mo, req.id, "  She worked those days after all ");
      assert.equal(removed.status, "cancelled");
      assert.equal(removed.decisionNote, "She worked those days after all");

      const audit = await auditFor(t.db, req.id);
      const last = audit.at(-1);
      assert.deepEqual([last?.action, last?.actorId, last?.subjectUserId], ["leave_request.cancelled", mo.id, ana.id]);
      assert.equal((last?.after as { decisionNote: string }).decisionNote, "She worked those days after all");
      const events = await eventsFor(t.db, co.companyId, req.id);
      assert.deepEqual([events.at(-1)?.type, (events.at(-1)?.payload as { actorId: string }).actorId], ["leave.cancelled", mo.id]);

      await ctx.settle();
      assert.deepEqual(ctx.sent.map((m) => [m.to, m.subject]), [[ana.email, "Time off was removed for you"]]);
      assert.match(ctx.sent[0].text, /^Mo removed your \S+, Mon, Oct 5 to Tue, Oct 6, 2026/);
      assert.match(ctx.sent[0].text, /Reason: “She worked those days after all”/);
    });

    test("only an admin or their manager may, with a reason, and only approved leave of the open year", async () => {
      const co = await seed();
      const ctx = createTestContext(t.db, { now });
      const { boss, mo, ana, bo } = co.people;
      const req = await pastLeaveOf(co);

      await rejectsWith(removeLeaveFor(ctx, ana, req.id, "mine"), "forbidden");
      await rejectsWith(removeLeaveFor(ctx, bo, req.id, "not mine"), "forbidden");
      await rejectsWith(removeLeaveFor(ctx, mo, req.id, "   "), "invalid_input");
      await rejectsWith(removeLeaveFor(ctx, mo, "not-a-uuid", "x"), "not_found");
      assert.equal((await requestsOf(t.db, ana.id))[0].status, "approved", "nothing written");

      assert.equal((await removeLeaveFor(ctx, boss, req.id, "Entered twice")).status, "cancelled");
      await rejectsWith(removeLeaveFor(ctx, boss, req.id, "again"), "invalid_transition");

      const lastYear = createTestContext(t.db, { now: new Date("2025-06-02T12:00:00Z") });
      const closed = await addLeaveFor(lastYear, boss, bo.id, { leaveTypeId: co.pto, startDate: "2025-06-09", endDate: "", dayPortion: "full" });
      await lastYear.settle();
      await rejectsWith(removeLeaveFor(ctx, boss, closed.id, "too late"), "past_year_closed");
    });

    test("the team page marks which leave the viewer may remove", async () => {
      const co = await seed();
      const ctx = createTestContext(t.db, { now });
      const { boss, mo, ana, bo } = co.people;
      const req = await pastLeaveOf(co);

      const removable = async (viewer: typeof mo) => (await getTeamMember(ctx, viewer, ana.id)).recent.find((e) => e.id === req.id)?.removable;
      assert.equal(await removable(mo), true);
      assert.equal(await removable(boss), true);
      assert.equal(await removable(bo), false);
      assert.equal(await removable(ana), false, "her own: not a correction");
    });

    test("leave earlier this year, past the 60-day list, is shown to those who may correct it, and only to them", async () => {
      const co = await seed();
      const ctx = createTestContext(t.db, { now });
      const { boss, mo, ana, bo } = co.people;
      const feb = createTestContext(t.db, { now: new Date("2026-01-26T12:00:00Z") });
      const winter = await addLeaveFor(feb, mo, ana.id, { leaveTypeId: co.pto, startDate: "2026-02-02", endDate: "2026-02-03", dayPortion: "full" });
      await feb.settle();

      const forManager = await getTeamMember(ctx, mo, ana.id);
      assert.deepEqual(forManager.earlier.map((e) => [e.id, e.removable]), [[winter.id, true]]);
      assert.equal(forManager.recent.some((e) => e.id === winter.id), false, "not in the 60-day list");
      assert.equal((await getTeamMember(ctx, boss, ana.id)).earlier.length, 1);
      assert.deepEqual((await getTeamMember(ctx, bo, ana.id)).earlier, []);
      assert.deepEqual((await getTeamMember(ctx, ana, ana.id)).earlier, []);
    });

    test("a manager who is no longer the person's manager is refused when removing their leave", async () => {
      const co = await seed();
      const ctx = createTestContext(t.db, { now });
      const { mo, ana, boss } = co.people;
      const req = await pastLeaveOf(co);
      await t.db.update(schema.user).set({ managerId: boss.id }).where(eq(schema.user.id, ana.id));
      await rejectsWith(removeLeaveFor(ctx, mo, req.id, "no longer mine"), "forbidden");
    });

    test("removing leave that began last year re-carries last year's unused days at once", async () => {
      const co = await seedCompany(t.db, {
        mo: { role: "manager" },
        ana: { managerKey: "mo", createdAt: "2025-01-01T00:00:00Z" },
      });
      const { mo, ana } = co.people;
      const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10, carryoverEnabled: true, carryoverMaxDays: 20 });
      await setAllowance(t.db, { userId: ana.id, leaveTypeId: vac, year: 2026, days: 10 });
      // Mon Dec 28 2026 to Tue Jan 5 2027: four days in 2026 and three in 2027 (no holidays seeded here).
      const december = createTestContext(t.db, { now: new Date("2026-12-14T12:00:00Z") });
      const req = await addLeaveFor(december, mo, ana.id, { leaveTypeId: vac, startDate: "2026-12-28", endDate: "2027-01-05", dayPortion: "full" });
      await december.settle();
      const january = createTestContext(t.db, { now: new Date("2027-01-04T12:00:00Z") });
      await runYearRollover(january, 2026);
      const carried = async () => (await allowancesOf(t.db, ana.id)).find((r) => r.leaveTypeId === vac && r.year === 2027)?.carriedOverDays;
      assert.equal(await carried(), 6, "10 less the four December days");

      await removeLeaveFor(january, mo, req.id, "Entered by mistake");
      assert.equal(await carried(), 10, "the December days carry without waiting for the nightly run");
      const carry = (await companyAudit(t.db, co.companyId, "allowance.carried_over")).at(-1);
      assert.deepEqual([carry?.actorKind, carry?.actorId], ["user", mo.id], "the re-carry names the manager who removed it");
    });
  });
});

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { messageForError } from "@/app/_lib/run-action";
import { isDomainError } from "@/domain/errors";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { updateCompanySettings } from "@/server/services/admin-company";
import { addHoliday, addUsFederalHolidays, deleteHoliday } from "@/server/services/admin-holidays";
import { decideLeaveRequest } from "@/server/services/approvals";
import { getBalanceSummary } from "@/server/services/balances";
import { cancelLeaveRequest, submitLeaveRequest } from "@/server/services/leave-requests";
import { rejectsWith } from "./assertions";
import { addLeaveType, auditFor, decidable, eventsFor, requestDaysOf, requestsOf, seedCompany, setAllowance } from "./fixtures";
import { createTestContext, createTestDatabase, needsServer, skip, type TestDatabase } from "./harness";

// The test clock is 2026-11-01, so 2026 is the open year and 2025 is closed.
// 2026-12-21 is a Monday; the fixture's only holiday is 2026-11-26 ("Thanksgiving").

describe("recounting submitted leave when holidays change", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("a new holiday takes a day off pending and approved requests on it, attributed to the admin via holiday_change", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      ana: { managerKey: "boss" },
      bob: { managerKey: "boss" },
      cy: { managerKey: "boss" },
    });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 20 });
    const ctx = createTestContext(t.db);
    const { boss, ana, bob, cy } = co.people;
    const week = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: vac,
      startDate: "2026-12-21",
      endDate: "2026-12-25",
      dayPortion: "full",
    });
    const approved = await submitLeaveRequest(ctx, bob, {
      leaveTypeId: vac,
      startDate: "2026-12-24",
      endDate: "2026-12-28",
      dayPortion: "full",
    });
    await decideLeaveRequest(ctx, boss, { requestId: approved.id, decision: "approve" });
    const rejected = await submitLeaveRequest(ctx, cy, { leaveTypeId: vac, startDate: "2026-12-25", dayPortion: "full" });
    await decideLeaveRequest(ctx, boss, { requestId: rejected.id, decision: "reject" });
    await ctx.settle();
    ctx.sent.length = 0;

    const { recount } = await addHoliday(ctx, boss, { date: "2026-12-25", name: "Christmas Day" });
    assert.deepEqual(recount, { recounted: 2, nowFree: 0, overdrawn: [] });
    assert.deepEqual(await requestDaysOf(t.db, week.id), [{ year: 2026, days: 4 }]);
    assert.deepEqual(
      await requestDaysOf(t.db, approved.id),
      [{ year: 2026, days: 2 }],
      "Dec 24 and 28; Christmas and the weekend are free",
    );
    assert.equal((await requestsOf(t.db, ana.id)).find((r) => r.id === week.id)?.days, 4, "the request's total moves with its split");

    const balance = (await getBalanceSummary(ctx, bob)).items.find((i) => i.leaveTypeId === vac)?.balance;
    assert.ok(balance?.tracked && balance.used === 2, "the balance counts the new total");

    const [recountAudit] = (await auditFor(t.db, week.id)).filter((a) => a.action === "leave_request.recounted");
    assert.equal(recountAudit.actorKind, "user");
    assert.equal(recountAudit.actorId, boss.id);
    assert.equal(recountAudit.actorVia, "holiday_change");
    assert.deepEqual([(recountAudit.before as { days: number }).days, (recountAudit.after as { days: number }).days], [5, 4]);

    const recounted = (await eventsFor(t.db, co.companyId, week.id)).find((e) => e.type === "leave.recounted");
    assert.ok(recounted, "a leave.recounted event is written");
    const payload = recounted.payload as { days: number; previousDays: number; actor: unknown };
    assert.deepEqual([payload.days, payload.previousDays], [4, 5]);
    assert.deepEqual(payload.actor, { type: "user", id: boss.id, via: "holiday_change" });
    assert.deepEqual(await requestDaysOf(t.db, rejected.id), [{ year: 2026, days: 1 }], "a rejected request on the holiday is left alone");
    assert.equal((await eventsFor(t.db, co.companyId, rejected.id)).filter((e) => e.type === "leave.recounted").length, 0);

    assert.equal(ctx.sent.length, 0, "nothing is emailed before commit settles");
    await ctx.settle();
    const toAna = ctx.sent.filter((m) => m.to === ana.email);
    assert.equal(toAna.length, 1);
    assert.equal(toAna[0].subject, "Your time off was recounted");
    assert.match(
      toAna[0].text,
      /Fri, Dec 25, 2026 is now a company holiday \(Christmas Day\), so your VAC for .+, 2026 now takes 4 days instead of 5 days\./,
    );
    assert.equal(ctx.sent.filter((m) => m.to === bob.email).length, 1);
    assert.equal(ctx.sent.filter((m) => m.to === cy.email).length, 0);
  });

  test("a request now entirely on a holiday costs nothing but is kept, and deleting the holiday restores it", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10 });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    const eve = await submitLeaveRequest(ctx, ana, { leaveTypeId: vac, startDate: "2026-12-24", dayPortion: "am" });
    await ctx.settle();
    ctx.sent.length = 0;

    const { holiday, recount } = await addHoliday(ctx, boss, { date: "2026-12-24", name: "Christmas Eve" });
    assert.deepEqual(recount, { recounted: 1, nowFree: 1, overdrawn: [] });
    let row = (await requestsOf(t.db, ana.id)).find((r) => r.id === eve.id);
    assert.deepEqual([row?.status, row?.days], ["pending", 0], "kept, still pending, at 0 days");
    assert.deepEqual(await requestDaysOf(t.db, eve.id), []);
    let balance = (await getBalanceSummary(ctx, ana)).items.find((i) => i.leaveTypeId === vac)?.balance;
    assert.ok(balance?.tracked && balance.pending === 0 && balance.remaining === 10, "nothing comes off the balance");
    assert.equal(
      (await eventsFor(t.db, co.companyId, eve.id)).filter((e) => e.type === "leave.cancelled").length,
      0,
      "nothing is cancelled",
    );

    await ctx.settle();
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].subject, "Your time off was recounted");
    assert.match(ctx.sent[0].text, /no longer takes any days, and nothing comes off your balance\./);

    // A mistaken holiday is undone by deleting it: the half day counts again.
    assert.deepEqual(await deleteHoliday(ctx, boss, holiday.id), { recounted: 1, nowFree: 0, overdrawn: [] });
    row = (await requestsOf(t.db, ana.id)).find((r) => r.id === eve.id);
    assert.deepEqual([row?.status, row?.days], ["pending", 0.5]);
    balance = (await getBalanceSummary(ctx, ana)).items.find((i) => i.leaveTypeId === vac)?.balance;
    assert.ok(balance?.tracked && balance.pending === 0.5);

    // The approver can still decide a 0-day request, and the person can still cancel it.
    await addHoliday(ctx, boss, { date: "2026-12-24", name: "Christmas Eve" });
    const decided = await decideLeaveRequest(ctx, boss, { requestId: eve.id, decision: "approve" });
    assert.deepEqual([decided.status, decided.days], ["approved", 0]);
    await cancelLeaveRequest(ctx, ana, eve.id);
    await rejectsWith(cancelLeaveRequest(ctx, ana, eve.id), "invalid_transition");
  });

  test("unticking a working day and ticking it again leaves every request as it was", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    const monday = await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-11-30", dayPortion: "full" });
    const week = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: co.pto,
      startDate: "2026-12-07",
      endDate: "2026-12-11",
      dayPortion: "full",
    });
    const settings = { name: "Acme", timezone: "UTC", allowancePolicy: "annual_calendar_year" };

    const off = await updateCompanySettings(ctx, boss, { ...settings, workingDays: [2, 3, 4, 5] });
    assert.deepEqual(off.recount, { recounted: 2, nowFree: 1, overdrawn: [] });
    assert.deepEqual([await requestDaysOf(t.db, monday.id), await requestDaysOf(t.db, week.id)], [[], [{ year: 2026, days: 4 }]]);
    const rows = await requestsOf(t.db, ana.id);
    assert.ok(
      rows.every((r) => r.status === "approved"),
      "nothing is cancelled",
    );

    const back = await updateCompanySettings(ctx, boss, { ...settings, workingDays: [1, 2, 3, 4, 5] });
    assert.deepEqual(back.recount, { recounted: 2, nowFree: 0, overdrawn: [] });
    assert.deepEqual(
      [await requestDaysOf(t.db, monday.id), await requestDaysOf(t.db, week.id)],
      [[{ year: 2026, days: 1 }], [{ year: 2026, days: 5 }]],
    );
    const [recounted] = (await auditFor(t.db, week.id)).filter((a) => a.action === "leave_request.recounted");
    assert.equal(recounted.actorVia, "working_days_change");
  });

  test("an earlier difference between a request and the calendar is left alone: only this change is applied", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 3 });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    // Dec 22 and 23 were holidays when Ana booked Dec 21 to 25: 3 days.
    await t.db.insert(schema.holidays).values([
      { companyId: co.companyId, date: "2026-12-22", name: "Office closed" },
      { companyId: co.companyId, date: "2026-12-23", name: "Office closed" },
    ]);
    const week = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: vac,
      startDate: "2026-12-21",
      endDate: "2026-12-25",
      dayPortion: "full",
    });
    assert.equal(week.days, 3);
    // They were then removed without a recount, as before recounting existed.
    await t.db
      .delete(schema.holidays)
      .where(and(eq(schema.holidays.companyId, co.companyId), inArray(schema.holidays.date, ["2026-12-22", "2026-12-23"])));
    await ctx.settle();
    ctx.sent.length = 0;

    const { recount } = await addHoliday(ctx, boss, { date: "2026-12-25", name: "Christmas Day" });
    assert.deepEqual(recount, { recounted: 1, nowFree: 0, overdrawn: [] }, "adding a holiday never raises a cost or overdraws");
    assert.deepEqual(await requestDaysOf(t.db, week.id), [{ year: 2026, days: 2 }], "exactly one day off");
    await ctx.settle();
    assert.match(ctx.sent[0].text, /now takes 2 days instead of 3 days\./);
  });

  test("each changed request gets its own email, and a move between years alone sends none", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-11-30", dayPortion: "full" });
    await submitLeaveRequest(ctx, ana, { leaveTypeId: co.pto, startDate: "2026-12-07", dayPortion: "full" });
    // Tue Dec 29, 2026 to Sun Jan 3, 2027: Tue to Thu in 2026 (3), Fri Jan 1 in 2027 (1).
    const span = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: co.pto,
      startDate: "2026-12-29",
      endDate: "2027-01-03",
      dayPortion: "full",
    });
    assert.deepEqual(await requestDaysOf(t.db, span.id), [
      { year: 2026, days: 3 },
      { year: 2027, days: 1 },
    ]);
    await ctx.settle();
    ctx.sent.length = 0;

    // Wednesday to Saturday: both Mondays drop out, and the span trades Tue Dec 29 for Sat Jan 2.
    const { recount } = await updateCompanySettings(ctx, boss, {
      name: "Acme",
      timezone: "UTC",
      allowancePolicy: "annual_calendar_year",
      workingDays: [3, 4, 5, 6],
    });
    assert.deepEqual(recount, { recounted: 3, nowFree: 2, overdrawn: [] });
    assert.deepEqual(await requestDaysOf(t.db, span.id), [
      { year: 2026, days: 2 },
      { year: 2027, days: 2 },
    ]);
    await ctx.settle();
    assert.equal(ctx.sent.length, 2, "one per request whose total changed; the span's total is still 3");
  });

  test("a move between years that leaves a year over its balance is emailed, saying the total is the same", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10 });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: vac, year: 2027, days: 1 });
    // Tue Dec 29, 2026 to Sun Jan 3, 2027: 3 days in 2026, Fri Jan 1 in 2027.
    const span = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: vac,
      startDate: "2026-12-29",
      endDate: "2027-01-03",
      dayPortion: "full",
    });
    await ctx.settle();
    ctx.sent.length = 0;

    // Wednesday to Saturday: Tue Dec 29 out, Sat Jan 2 in. Still 4 days, but 2027 now holds 2 of its 1.
    const { recount } = await updateCompanySettings(ctx, boss, {
      name: "Acme",
      timezone: "UTC",
      allowancePolicy: "annual_calendar_year",
      workingDays: [3, 4, 5, 6],
    });
    assert.deepEqual(await requestDaysOf(t.db, span.id), [
      { year: 2026, days: 2 },
      { year: 2027, days: 2 },
    ]);
    assert.deepEqual(
      recount.overdrawn.map((o) => [o.year, o.over]),
      [[2027, 1]],
    );
    await ctx.settle();
    assert.equal(ctx.sent.length, 1, "the person hears it, as the admin does");
    assert.match(ctx.sent[0].text, /still takes 4 days, but some of it now counts in a different year\./);
    assert.match(ctx.sent[0].text, /This leaves you 1 day over your .+ balance for 2027\./);
  });

  test("deleting a holiday counts the day again, keeps an overdrawn request, and says who is over", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 3 });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    const { holiday } = await addHoliday(ctx, boss, { date: "2026-12-24", name: "Christmas Eve" });
    // Mon 21 to Thu 24 with Christmas Eve off: 3 days, the whole allowance.
    const week = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: vac,
      startDate: "2026-12-21",
      endDate: "2026-12-24",
      dayPortion: "full",
    });
    assert.equal(week.days, 3);
    await ctx.settle();
    ctx.sent.length = 0;

    const recount = await deleteHoliday(ctx, boss, holiday.id);
    assert.deepEqual(recount, {
      recounted: 1,
      nowFree: 0,
      overdrawn: [{ userId: ana.id, leaveTypeId: vac, personName: "Ana", leaveTypeName: "VAC", year: 2026, over: 1 }],
    });
    const row = (await requestsOf(t.db, ana.id)).find((r) => r.id === week.id);
    assert.deepEqual([row?.status, row?.days], ["approved", 4], "kept, now 4 days");
    const balance = (await getBalanceSummary(ctx, ana)).items.find((i) => i.leaveTypeId === vac)?.balance;
    assert.ok(balance?.tracked && balance.remaining === -1);

    await ctx.settle();
    assert.equal(ctx.sent.length, 1);
    assert.match(
      ctx.sent[0].text,
      /Thu, Dec 24, 2026 is no longer a company holiday, so your VAC for .+, 2026 now takes 4 days instead of 3 days\./,
    );
    assert.match(ctx.sent[0].text, /Balance: This leaves you 1 day over your VAC balance for 2026\./);
  });

  test("closed years keep their counts: only the open year of a request over New Year moves", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true } });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    // Mon Dec 29, 2025 to Fri Jan 2, 2026: 3 days in 2025, 2 in 2026.
    const span = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: co.pto,
      startDate: "2025-12-29",
      endDate: "2026-01-02",
      dayPortion: "full",
    });
    assert.deepEqual(await requestDaysOf(t.db, span.id), [
      { year: 2025, days: 3 },
      { year: 2026, days: 2 },
    ]);

    const closed = await addHoliday(ctx, boss, { date: "2025-12-31", name: "New Year's Eve" });
    assert.deepEqual(closed.recount, { recounted: 0, nowFree: 0, overdrawn: [] }, "a holiday in a closed year recounts nothing");
    assert.deepEqual(await requestDaysOf(t.db, span.id), [
      { year: 2025, days: 3 },
      { year: 2026, days: 2 },
    ]);

    const open = await addHoliday(ctx, boss, { date: "2026-01-01", name: "New Year's Day" });
    assert.deepEqual(open.recount, { recounted: 1, nowFree: 0, overdrawn: [] });
    assert.deepEqual(
      await requestDaysOf(t.db, span.id),
      [
        { year: 2025, days: 3 },
        { year: 2026, days: 1 },
      ],
      "2025 keeps 3, though Dec 31 is now a holiday too: that year is settled",
    );
  });

  test("adding the federal set recounts each request once, with one email naming the holidays", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true }, other: {} });
    const elsewhere = await seedCompany(t.db, { them: { canSelfApprove: true } });
    const ctx = createTestContext(t.db);
    const { boss, ana } = co.people;
    // Thu Dec 24, 2026 to Fri Jan 1, 2027: Christmas (Fri Dec 25) and New Year's Day are federal.
    const trip = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: co.pto,
      startDate: "2026-12-21",
      endDate: "2026-12-31",
      dayPortion: "full",
    });
    const theirs = await submitLeaveRequest(ctx, elsewhere.people.them, {
      leaveTypeId: elsewhere.pto,
      startDate: "2026-12-21",
      endDate: "2026-12-31",
      dayPortion: "full",
    });
    await ctx.settle();
    ctx.sent.length = 0;

    const { recount } = await addUsFederalHolidays(ctx, boss, 2026);
    assert.deepEqual(recount, { recounted: 1, nowFree: 0, overdrawn: [] });
    assert.deepEqual(await requestDaysOf(t.db, trip.id), [{ year: 2026, days: 8 }], "9 weekdays minus Christmas");
    assert.deepEqual(await requestDaysOf(t.db, theirs.id), [{ year: 2026, days: 9 }], "another company's leave is untouched");
    await ctx.settle();
    assert.equal(ctx.sent.length, 1);
    assert.match(ctx.sent[0].text, /Fri, Dec 25, 2026 is now a company holiday \(Christmas Day\)/);
  });

  test("a request on a holiday is refused with the holiday's name", async () => {
    const co = await seedCompany(t.db, { ana: { canSelfApprove: true } });
    const ctx = createTestContext(t.db);
    let message = "";
    await assert.rejects(
      submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-11-26", dayPortion: "full" }),
      (err) => {
        assert.ok(isDomainError(err, "zero_days"));
        message = messageForError(err, "test");
        return true;
      },
    );
    assert.equal(message, "Thu, Nov 26, 2026 is Thanksgiving, a company holiday, so there's nothing to request.");
  });

  test("approvers see who else is off on the same dates, in the inbox and the request email", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      ana: { managerKey: "boss" },
      victor: { canSelfApprove: true },
      chrismer: { managerKey: "boss" },
      later: { canSelfApprove: true },
    });
    const ctx = createTestContext(t.db);
    const { boss, ana, victor, chrismer, later } = co.people;
    await submitLeaveRequest(ctx, victor, { leaveTypeId: co.pto, startDate: "2026-12-21", endDate: "2026-12-22", dayPortion: "full" });
    await submitLeaveRequest(ctx, chrismer, { leaveTypeId: co.pto, startDate: "2026-12-23", dayPortion: "pm" });
    const notThen = await submitLeaveRequest(ctx, later, { leaveTypeId: co.pto, startDate: "2027-01-04", dayPortion: "full" });
    assert.equal(notThen.status, "approved");
    await ctx.settle();
    ctx.sent.length = 0;

    const mine = await submitLeaveRequest(ctx, ana, {
      leaveTypeId: co.pto,
      startDate: "2026-12-22",
      endDate: "2026-12-23",
      dayPortion: "full",
    });
    await ctx.settle();
    const toBoss = ctx.sent.find((m) => m.to === boss.email);
    assert.ok(toBoss);
    assert.ok(toBoss.text.includes("Also off then: Victor and Chrismer (not approved yet)."), "the email carries the line Approvals shows");

    const { items } = await decidable(ctx, boss);
    const item = items.find((i) => i.id === mine.id);
    assert.deepEqual(
      item?.alsoOff,
      { others: 2, line: "Also off then: Victor and Chrismer (not approved yet)." },
      "Later's leave in January isn't listed",
    );
    const chrismersItem = items.find((i) => i.requesterId === chrismer.id);
    assert.equal(chrismersItem?.alsoOff?.line, "Ana (not approved yet) is off then too.", "nobody is listed as off alongside themselves");
  });

  test("someone whose leave overlaps only on a weekend is not listed as also off, as on the team calendar", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      wen: { canSelfApprove: true },
      zed: { managerKey: "boss" },
      yan: { managerKey: "boss" },
    });
    const ctx = createTestContext(t.db);
    const { boss, wen, zed, yan } = co.people;
    // Thu Dec 24 to Sun Dec 27: Wen's working days are Thursday and Friday.
    await submitLeaveRequest(ctx, wen, { leaveTypeId: co.pto, startDate: "2026-12-24", endDate: "2026-12-27", dayPortion: "full" });
    // Sat Dec 26 to Mon Dec 28 overlaps Wen's only on the weekend.
    const weekendOnly = await submitLeaveRequest(ctx, zed, {
      leaveTypeId: co.pto,
      startDate: "2026-12-26",
      endDate: "2026-12-28",
      dayPortion: "full",
    });
    // Fri Dec 25 overlaps Wen's Friday, a working day (and not Zed's leave).
    const workingDay = await submitLeaveRequest(ctx, yan, { leaveTypeId: co.pto, startDate: "2026-12-25", dayPortion: "full" });
    const { items } = await decidable(ctx, boss);
    assert.deepEqual(items.find((i) => i.id === weekendOnly.id)?.alsoOff, { others: 0, line: "Nobody else is off then." });
    assert.equal(items.find((i) => i.id === workingDay.id)?.alsoOff?.line, "Wen is off then too.");
  });

  test("each balance a recount pushes over is reported once, and untracked types never are", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { canSelfApprove: true }, bo: { canSelfApprove: true } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10 });
    const ctx = createTestContext(t.db);
    const { boss, ana, bo } = co.people;
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: vac, year: 2026, days: 1 });
    const { holiday } = await addHoliday(ctx, boss, { date: "2026-12-24", name: "Christmas Eve" });
    await submitLeaveRequest(ctx, ana, { leaveTypeId: vac, startDate: "2026-12-24", endDate: "2026-12-25", dayPortion: "full" });
    await submitLeaveRequest(ctx, bo, { leaveTypeId: co.pto, startDate: "2026-12-23", endDate: "2026-12-24", dayPortion: "full" });

    const recount = await deleteHoliday(ctx, boss, holiday.id);
    assert.equal(recount.recounted, 2);
    assert.deepEqual(
      recount.overdrawn.map((o) => [o.leaveTypeName, o.over]),
      [["VAC", 1]],
      "VAC is 1 over; PTO has no limit",
    );
  });

  test(
    "a submit waits while a calendar change holds the company, so it is never counted with the old calendar",
    { skip: needsServer },
    async () => {
      const co = await seedCompany(t.db, { ana: { canSelfApprove: true } });
      const ctx = createTestContext(t.db);
      const holder = await t.client.reserve();
      try {
        await holder`begin`;
        // What addHoliday, deleteHoliday and a working-days change take first.
        await holder`select id from companies where id = ${co.companyId} for no key update`;
        const submit = submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: co.pto, startDate: "2026-12-24", dayPortion: "full" });
        const raced = await Promise.race([
          submit.then(() => "done" as const),
          new Promise<"waiting">((r) => setTimeout(() => r("waiting"), 500)),
        ]);
        assert.equal(raced, "waiting", "the submit must not count days while the calendar is changing");
        await holder`insert into holidays (company_id, date, name) values (${co.companyId}, '2026-12-24', 'Christmas Eve')`;
        await holder`commit`;
        await rejectsWith(submit, "zero_days");
      } finally {
        holder.release();
      }
    },
  );
});

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { and, asc, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { decideLeaveRequest } from "@/server/services/approvals";
import { getBalanceSummary, previewLeaveRequest } from "@/server/services/balances";
import { cancelLeaveRequest, submitLeaveRequest } from "@/server/services/leave-requests";
import { runYearRollover } from "@/server/services/rollover";
import { rejectsWith } from "./assertions";
import { addLeaveType, allowancesOf, seedCompany, setAllowance } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

/** Rollover runs over every company in the database, so this file owns its own. */
describe("year rollover", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function balanceEvents(companyId: string) {
    return t.db
      .select()
      .from(schema.eventsOutbox)
      .where(and(eq(schema.eventsOutbox.companyId, companyId), eq(schema.eventsOutbox.type, "balance.adjusted")))
      .orderBy(asc(schema.eventsOutbox.createdAt));
  }
  async function allowanceAudit(companyId: string) {
    return t.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.companyId, companyId), eq(schema.auditLog.entityType, "allowance")))
      .orderBy(asc(schema.auditLog.createdAt));
  }

  test("carries the closing year's remaining (capped) into next year, creates current-year rows, and a re-run changes nothing", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin", createdAt: "2025-01-01T00:00:00Z" },
      ana: { managerKey: "boss", createdAt: "2025-03-01T00:00:00Z" },
      bo: { managerKey: "boss", createdAt: "2025-03-01T00:00:00Z" },
      newbie: { managerKey: "boss", createdAt: "2027-01-02T12:00:00Z" },
      gone: { managerKey: "boss", isActive: false, createdAt: "2025-03-01T00:00:00Z" },
    });
    const capped = await addLeaveType(t.db, co.companyId, { code: "CAP", defaultAllowanceDays: 10, carryoverEnabled: true, carryoverMaxDays: 5 });
    const uncapped = await addLeaveType(t.db, co.companyId, { code: "FREE", defaultAllowanceDays: 4, carryoverEnabled: true });
    const plain = await addLeaveType(t.db, co.companyId, { code: "PLAIN", defaultAllowanceDays: 10 });
    const sick = await addLeaveType(t.db, co.companyId, { code: "SICK", carryoverEnabled: true });
    const { ana, bo, boss, newbie, gone } = co.people;

    // 2026 bookings, made in 2026.
    const in2026 = createTestContext(t.db, { now: new Date("2026-11-01T15:00:00Z") });
    const anaWeek = await submitLeaveRequest(in2026, ana, { leaveTypeId: capped, startDate: "2026-11-02", endDate: "2026-11-04", dayPortion: "full" });
    await decideLeaveRequest(in2026, boss, { requestId: anaWeek.id, decision: "approve" });
    const anaPending = await submitLeaveRequest(in2026, ana, { leaveTypeId: uncapped, startDate: "2026-11-05", dayPortion: "full" });
    await setAllowance(t.db, { userId: bo.id, leaveTypeId: capped, year: 2026, days: 5 });
    await submitLeaveRequest(in2026, bo, { leaveTypeId: capped, startDate: "2026-11-09", endDate: "2026-11-11", dayPortion: "full" });
    // An admin later lowers Bo's 2026 allowance below what was booked.
    await setAllowance(t.db, { userId: bo.id, leaveTypeId: capped, year: 2026, days: 2 });
    // A custom 2027 allowance that must survive.
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: plain, year: 2027, days: 20 });

    const jan = createTestContext(t.db, { now: new Date("2027-01-05T15:00:00Z") });
    const first = await runYearRollover(jan);

    // Ana: CAP remaining 7 -> 5 (cap); FREE remaining 3 (pending counts) -> 3; PLAIN keeps 20.
    assert.deepEqual(await allowancesOf(t.db, ana.id), [
      { leaveTypeId: capped, year: 2027, days: 10, carriedOverDays: 5, adjustmentDays: 0 },
      { leaveTypeId: uncapped, year: 2027, days: 4, carriedOverDays: 3, adjustmentDays: 0 },
      { leaveTypeId: plain, year: 2027, days: 20, carriedOverDays: 0, adjustmentDays: 0 },
    ].sort((a, b) => a.leaveTypeId.localeCompare(b.leaveTypeId)));
    // Bo overdrew 2026: carries 0, not a debt. FREE carries its full 4.
    const boRows = await allowancesOf(t.db, bo.id);
    assert.deepEqual(
      boRows.filter((r) => r.year === 2027).map((r) => [r.leaveTypeId, r.days, r.carriedOverDays]).sort(),
      [
        [capped, 10, 0],
        [uncapped, 4, 4],
        [plain, 10, 0],
      ].sort(),
    );
    // Joined in 2027: current-year rows from defaults, nothing carried. Inactive: untouched.
    assert.deepEqual(
      (await allowancesOf(t.db, newbie.id)).map((r) => [r.leaveTypeId, r.year, r.days, r.carriedOverDays]).sort(),
      [
        [capped, 2027, 10, 0],
        [uncapped, 2027, 4, 0],
        [plain, 2027, 10, 0],
      ].sort(),
    );
    assert.deepEqual(await allowancesOf(t.db, gone.id), []);
    // The untracked type never gets a row.
    for (const who of [ana, bo, newbie, boss]) {
      assert.ok((await allowancesOf(t.db, who.id)).every((r) => r.leaveTypeId !== sick));
    }

    // Carried: Ana CAP + FREE, Bo FREE (CAP carries 0, so no row is made for it), Boss
    // CAP + FREE. Created from defaults: Bo CAP + PLAIN, Boss PLAIN, Newbie all three.
    assert.deepEqual(first, { companies: 1, members: 4, carried: 5, created: 6 });

    const events = await balanceEvents(co.companyId);
    const audit = await allowanceAudit(co.companyId);
    assert.equal(events.length, first.carried + first.created);
    assert.equal(audit.length, events.length);
    assert.ok(audit.every((a) => a.actorId === null));
    assert.deepEqual(
      [...new Set(audit.map((a) => a.action))].sort(),
      ["allowance.carried_over", "allowance.created"],
    );
    const anaCap = events.find((e) => {
      const p = e.payload as { userId: string; leaveTypeId: string };
      return p.userId === ana.id && p.leaveTypeId === capped;
    });
    assert.ok(anaCap);
    assert.deepEqual({ ...(anaCap.payload as object), allowanceId: "x" }, {
      allowanceId: "x",
      userId: ana.id,
      leaveTypeId: capped,
      year: 2027,
      days: 10,
      carriedOverDays: 5,
      adjustmentDays: 0,
      reason: "carryover",
      actorId: null,
    });

    // The carried days show up in 2027's balance.
    const anaCap2027 = (await getBalanceSummary(jan, ana)).items.find((i) => i.leaveTypeId === capped);
    assert.deepEqual(anaCap2027?.balance, {
      tracked: true, allowance: 10, carriedOver: 5, adjustment: 0, total: 15, used: 0, pending: 0, carriedOut: 0, remaining: 15,
    });

    // Idempotent: same data, same values, no new audit or events.
    const before = await Promise.all([ana, bo, newbie, boss].map((p) => allowancesOf(t.db, p.id)));
    assert.deepEqual(await runYearRollover(jan), { companies: 1, members: 4, carried: 0, created: 0 });
    assert.deepEqual(await runYearRollover(jan, 2026), { companies: 1, members: 4, carried: 0, created: 0 });
    assert.deepEqual(await Promise.all([ana, bo, newbie, boss].map((p) => allowancesOf(t.db, p.id))), before);
    assert.equal((await balanceEvents(co.companyId)).length, events.length);
    assert.equal((await allowanceAudit(co.companyId)).length, audit.length);

    // Cancelling 2026 leave afterwards frees it; the next run recomputes and records it.
    await cancelLeaveRequest(jan, ana, anaPending.id);
    assert.deepEqual(await runYearRollover(jan), { companies: 1, members: 4, carried: 1, created: 0 });
    const freeRow = (await allowancesOf(t.db, ana.id)).find((r) => r.leaveTypeId === uncapped && r.year === 2027);
    assert.equal(freeRow?.carriedOverDays, 4);
    const lastAudit = (await allowanceAudit(co.companyId)).at(-1);
    assert.equal(lastAudit?.action, "allowance.carried_over");
    assert.deepEqual(
      [(lastAudit?.before as { carriedOverDays: number }).carriedOverDays, (lastAudit?.after as { carriedOverDays: number }).carriedOverDays],
      [3, 4],
    );
  });

  test("with carryover off nothing carries; it only creates missing current-year rows, never overwriting", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin", createdAt: "2025-01-01T00:00:00Z" } });
    const plain = await addLeaveType(t.db, co.companyId, { code: "PLAIN", defaultAllowanceDays: 10 });
    await setAllowance(t.db, { userId: co.people.boss.id, leaveTypeId: plain, year: 2026, days: 10 });
    const result = await runYearRollover(createTestContext(t.db, { now: new Date("2027-02-01T15:00:00Z") }));
    assert.equal(result.carried, 0);
    assert.deepEqual(await allowancesOf(t.db, co.people.boss.id), [
      { leaveTypeId: plain, year: 2026, days: 10, carriedOverDays: 0, adjustmentDays: 0 },
      { leaveTypeId: plain, year: 2027, days: 10, carriedOverDays: 0, adjustmentDays: 0 },
    ]);
  });

  test("days carried out of a closed year count as spent there: backdated leave cannot spend them twice", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin", createdAt: "2025-01-01T00:00:00Z" },
      ana: { managerKey: "boss", createdAt: "2025-03-01T00:00:00Z" },
    });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 5, carryoverEnabled: true, carryoverMaxDays: 5 });
    const plain = await addLeaveType(t.db, co.companyId, { code: "PLAIN", defaultAllowanceDays: 5 });
    const ana = co.people.ana;
    const jan = createTestContext(t.db, { now: new Date("2027-01-05T15:00:00Z") });
    await runYearRollover(jan);
    assert.equal((await allowancesOf(t.db, ana.id)).find((r) => r.leaveTypeId === vac && r.year === 2027)?.carriedOverDays, 5);

    // Ana spends 2027's allowance plus everything carried in: Mon Feb 1 to Fri Feb 12.
    await submitLeaveRequest(jan, ana, { leaveTypeId: vac, startDate: "2027-02-01", endDate: "2027-02-12", dayPortion: "full" });
    const backdated = { leaveTypeId: vac, startDate: "2026-12-07", endDate: "2026-12-11", dayPortion: "full" as const };

    // The 5 days left in 2026 went into 2027, so 2026 has none left to book.
    const closed = await getBalanceSummary(jan, ana, 2026);
    assert.deepEqual(closed.items.find((i) => i.leaveTypeId === vac)?.balance, {
      tracked: true, allowance: 5, carriedOver: 0, adjustment: 0, total: 5, used: 0, pending: 0, carriedOut: 5, remaining: 0,
    });
    await rejectsWith(previewLeaveRequest(jan, ana, backdated), "insufficient_balance");
    await rejectsWith(submitLeaveRequest(jan, ana, { ...backdated, endDate: "2026-12-07" }), "insufficient_balance");

    // Mirror: a type without carryover carried nothing out, so the same backdated week fits.
    assert.deepEqual(await previewLeaveRequest(jan, ana, { ...backdated, leaveTypeId: plain }), {
      days: 5,
      years: [{ year: 2026, days: 5, remainingAfter: 0 }],
    });
    assert.equal((await submitLeaveRequest(jan, ana, { ...backdated, leaveTypeId: plain })).days, 5);

    // Re-running reads the carry as already made, so it neither shrinks nor grows it.
    await runYearRollover(jan);
    assert.equal((await allowancesOf(t.db, ana.id)).find((r) => r.leaveTypeId === vac && r.year === 2027)?.carriedOverDays, 5);
  });

  test("a capped carry leaves only the uncarried rest of the closed year bookable, and re-running keeps the carry", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin", canSelfApprove: true, createdAt: "2025-01-01T00:00:00Z" } });
    const cap = await addLeaveType(t.db, co.companyId, { code: "CAP", defaultAllowanceDays: 7, carryoverEnabled: true, carryoverMaxDays: 5 });
    const boss = co.people.boss;
    const jan = createTestContext(t.db, { now: new Date("2027-01-05T15:00:00Z") });
    await runYearRollover(jan);

    const ask = (endDate: string) => submitLeaveRequest(jan, boss, { leaveTypeId: cap, startDate: "2026-12-07", endDate, dayPortion: "full" });
    await rejectsWith(ask("2026-12-09"), "insufficient_balance");
    assert.equal((await ask("2026-12-08")).status, "approved");

    // 2026 remaining before carrying is now 5, still the cap: the carry stays 5.
    await runYearRollover(jan);
    assert.equal((await allowancesOf(t.db, boss.id)).find((r) => r.leaveTypeId === cap && r.year === 2027)?.carriedOverDays, 5);
    const closed = (await getBalanceSummary(jan, boss, 2026)).items.find((i) => i.leaveTypeId === cap)?.balance;
    assert.ok(closed?.tracked);
    assert.deepEqual([closed.used, closed.carriedOut, closed.remaining], [2, 5, 0]);
  });

  test("a type with no default stays tracked next year whether or not anything carries", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin", createdAt: "2025-01-01T00:00:00Z" },
      ana: { managerKey: "boss", createdAt: "2025-03-01T00:00:00Z" },
      bo: { managerKey: "boss", createdAt: "2025-03-01T00:00:00Z" },
    });
    const study = await addLeaveType(t.db, co.companyId, { code: "STUDY", defaultAllowanceDays: null, carryoverEnabled: true });
    const { ana, bo } = co.people;
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: study, year: 2026, days: 0 });
    await setAllowance(t.db, { userId: bo.id, leaveTypeId: study, year: 2026, days: 2 });
    const jan = createTestContext(t.db, { now: new Date("2027-01-05T15:00:00Z") });
    await runYearRollover(jan);

    const study2027 = async (who: typeof ana) => (await getBalanceSummary(jan, who)).items.find((i) => i.leaveTypeId === study)?.balance;
    assert.deepEqual(await study2027(ana), {
      tracked: true, allowance: 0, carriedOver: 0, adjustment: 0, total: 0, used: 0, pending: 0, carriedOut: 0, remaining: 0,
    });
    assert.deepEqual(await study2027(bo), {
      tracked: true, allowance: 2, carriedOver: 2, adjustment: 0, total: 4, used: 0, pending: 0, carriedOut: 0, remaining: 4,
    });
    await rejectsWith(submitLeaveRequest(jan, ana, { leaveTypeId: study, startDate: "2027-02-01", dayPortion: "full" }), "insufficient_balance");

    // Nobody without a closing-year row gets one: the boss stays untracked.
    assert.deepEqual(await allowancesOf(t.db, co.people.boss.id), []);
    const actions = (await allowanceAudit(co.companyId)).map((a) => [(a.after as { userId: string }).userId, a.action]);
    assert.deepEqual(actions.sort(), [
      [ana.id, "allowance.created"],
      [bo.id, "allowance.carried_over"],
    ].sort());
    // And the re-run is quiet for both.
    const before = (await allowanceAudit(co.companyId)).length;
    await runYearRollover(jan);
    assert.equal((await allowanceAudit(co.companyId)).length, before);
  });

  test("a type with no default is copied forward with carryover off exactly as with it on, minus the carry", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin", createdAt: "2025-01-01T00:00:00Z" },
      ana: { managerKey: "boss", createdAt: "2025-03-01T00:00:00Z" },
    });
    const on = await addLeaveType(t.db, co.companyId, { code: "ON", defaultAllowanceDays: null, carryoverEnabled: true });
    const off = await addLeaveType(t.db, co.companyId, { code: "OFF", defaultAllowanceDays: null });
    const { ana, boss } = co.people;
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: on, year: 2026, days: 2 });
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: off, year: 2026, days: 2 });
    const jan = createTestContext(t.db, { now: new Date("2027-01-05T15:00:00Z") });
    await runYearRollover(jan);

    assert.deepEqual(
      (await allowancesOf(t.db, ana.id)).filter((r) => r.year === 2027),
      [
        { leaveTypeId: on, year: 2027, days: 2, carriedOverDays: 2, adjustmentDays: 0 },
        { leaveTypeId: off, year: 2027, days: 2, carriedOverDays: 0, adjustmentDays: 0 },
      ].sort((a, b) => a.leaveTypeId.localeCompare(b.leaveTypeId)),
    );
    const balance2027 = async (type: string) => (await getBalanceSummary(jan, ana)).items.find((i) => i.leaveTypeId === type)?.balance;
    assert.deepEqual(await balance2027(off), {
      tracked: true, allowance: 2, carriedOver: 0, adjustment: 0, total: 2, used: 0, pending: 0, carriedOut: 0, remaining: 2,
    });
    assert.deepEqual(await balance2027(on), {
      tracked: true, allowance: 2, carriedOver: 2, adjustment: 0, total: 4, used: 0, pending: 0, carriedOut: 0, remaining: 4,
    });
    // Six weeks of leave is refused on both, carryover or not.
    const sixWeeks = { startDate: "2027-02-01", endDate: "2027-03-12", dayPortion: "full" as const };
    await rejectsWith(previewLeaveRequest(jan, ana, { ...sixWeeks, leaveTypeId: off }), "insufficient_balance");
    await rejectsWith(previewLeaveRequest(jan, ana, { ...sixWeeks, leaveTypeId: on }), "insufficient_balance");
    await rejectsWith(submitLeaveRequest(jan, ana, { ...sixWeeks, leaveTypeId: off }), "insufficient_balance");

    const actions = (await allowanceAudit(co.companyId)).map((a) => [(a.after as { leaveTypeId: string }).leaveTypeId, a.action]);
    assert.deepEqual(actions.sort(), [
      [off, "allowance.created"],
      [on, "allowance.carried_over"],
    ].sort());
    // Someone who never had a row for either stays without one, and untracked.
    assert.deepEqual(await allowancesOf(t.db, boss.id), []);

    // A re-run writes nothing.
    const before = (await allowanceAudit(co.companyId)).length;
    const events = (await balanceEvents(co.companyId)).length;
    await runYearRollover(jan);
    assert.equal((await allowanceAudit(co.companyId)).length, before);
    assert.equal((await balanceEvents(co.companyId)).length, events);
  });

  test("before the rollover, a type with no default is limited in later years by the person's latest row", async () => {
    const co = await seedCompany(t.db, {
      boss: { role: "admin", canSelfApprove: true, createdAt: "2025-01-01T00:00:00Z" },
      ana: { managerKey: "boss", canSelfApprove: true, createdAt: "2025-03-01T00:00:00Z" },
    });
    const study = await addLeaveType(t.db, co.companyId, { code: "STUDY", defaultAllowanceDays: null });
    const { ana, boss } = co.people;
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: study, year: 2026, days: 5 });
    const nov = createTestContext(t.db, { now: new Date("2026-11-01T15:00:00Z") });

    // Booking 2027 ahead: two weeks is refused by preview and submit (self-approved too).
    const twoWeeks = { leaveTypeId: study, startDate: "2027-02-01", endDate: "2027-02-12", dayPortion: "full" as const };
    await rejectsWith(previewLeaveRequest(nov, ana, twoWeeks), "insufficient_balance");
    await rejectsWith(submitLeaveRequest(nov, ana, twoWeeks), "insufficient_balance");
    // One week fits exactly.
    const oneWeek = { ...twoWeeks, endDate: "2027-02-05" };
    assert.deepEqual(await previewLeaveRequest(nov, ana, oneWeek), { days: 5, years: [{ year: 2027, days: 5, remainingAfter: 0 }] });
    assert.equal((await submitLeaveRequest(nov, ana, oneWeek)).status, "approved");

    // Over New Year (Thu Dec 31 to Mon Jan 4): 1 day in 2026, 2 in 2027. The January
    // part is checked against 2027, which is spent.
    const newYear = { leaveTypeId: study, startDate: "2026-12-31", endDate: "2027-01-04", dayPortion: "full" as const };
    await rejectsWith(previewLeaveRequest(nov, ana, newYear), "insufficient_balance");
    await rejectsWith(submitLeaveRequest(nov, ana, newYear), "insufficient_balance");
    // Mirror: the boss never had a row, so the type is unlimited for them.
    assert.deepEqual(await previewLeaveRequest(nov, boss, newYear), {
      days: 3,
      years: [
        { year: 2026, days: 1, remainingAfter: null },
        { year: 2027, days: 2, remainingAfter: null },
      ],
    });
    assert.equal((await submitLeaveRequest(nov, boss, newYear)).days, 3);

    const study2027 = async (ctx: typeof nov) => (await getBalanceSummary(ctx, ana, 2027)).items.find((i) => i.leaveTypeId === study)?.balance;
    const inherited = {
      tracked: true, allowance: 5, carriedOver: 0, adjustment: 0, total: 5, used: 5, pending: 0, carriedOut: 0, remaining: 0,
    };
    assert.deepEqual(await study2027(nov), inherited);

    // The rollover makes the inherited row explicit; the balance doesn't move.
    const jan = createTestContext(t.db, { now: new Date("2027-01-05T15:00:00Z") });
    await runYearRollover(jan);
    assert.deepEqual(
      (await allowancesOf(t.db, ana.id)).find((r) => r.leaveTypeId === study && r.year === 2027),
      { leaveTypeId: study, year: 2027, days: 5, carriedOverDays: 0, adjustmentDays: 0 },
    );
    assert.deepEqual(await study2027(jan), inherited);
    assert.deepEqual(await allowancesOf(t.db, boss.id), []);
  });

  test("refuses to close a year that hasn't ended, and fails before any change on an unknown policy", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    await addLeaveType(t.db, co.companyId, { code: "PLAIN", defaultAllowanceDays: 10 });
    const ctx = createTestContext(t.db, { now: new Date("2027-03-01T15:00:00Z") });
    await rejectsWith(runYearRollover(ctx, 2027), "invalid_input");

    await t.db.update(schema.companies).set({ allowancePolicy: "accrual_monthly" }).where(eq(schema.companies.id, co.companyId));
    const before = await allowancesOf(t.db, co.people.boss.id);
    try {
      await rejectsWith(runYearRollover(ctx), "policy_unavailable");
      assert.deepEqual(await allowancesOf(t.db, co.people.boss.id), before);
    } finally {
      await t.db.update(schema.companies).set({ allowancePolicy: "annual_calendar_year" }).where(eq(schema.companies.id, co.companyId));
    }
  });
});

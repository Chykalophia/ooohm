import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { type BalanceShortfallDetails, isDomainError } from "@/domain/errors";
import { decideLeaveRequest } from "@/server/services/approvals";
import { getBalanceSummary, previewLeaveRequest } from "@/server/services/balances";
import { cancelLeaveRequest, getDashboard, submitLeaveRequest } from "@/server/services/leave-requests";
import { rejectsWith } from "./assertions";
import { addLeaveType, eventsFor, requestDaysOf, requestsOf, seedCompany, setAllowance } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestContext, type TestDatabase } from "./harness";

// Dates: 2026-11-02 is a Monday; 2026-11-26 (Thu) is the seeded holiday. The test clock
// is 2026-11-01, so "this year" is 2026.

/** The balance of one leave type in the actor's summary for `year`. */
async function balanceOf(ctx: TestContext, actor: Actor, leaveTypeId: string, year?: number) {
  const summary = await getBalanceSummary(ctx, actor, year);
  const item = summary.items.find((i) => i.leaveTypeId === leaveTypeId);
  assert.ok(item, `leave type ${leaveTypeId} is in the summary`);
  return item.balance;
}

/** Asserts a rejection with `insufficient_balance` and returns its details. */
async function shortfallOf(promise: Promise<unknown>): Promise<BalanceShortfallDetails> {
  let details: BalanceShortfallDetails | undefined;
  await assert.rejects(promise, (err) => {
    assert.ok(isDomainError(err, "insufficient_balance"), `expected insufficient_balance, got ${String(err)}`);
    details = err.details;
    return true;
  });
  assert.ok(details);
  return details;
}

describe("balances: counting, enforcement and the live preview", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("approved days are used, pending shown apart, half days 0.5, holidays free; rejecting and cancelling give days back", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10 });
    const ctx = createTestContext(t.db);
    const { ana, boss } = co.people;

    assert.deepEqual(await balanceOf(ctx, ana, vac), {
      tracked: true, allowance: 10, carriedOver: 0, adjustment: 0, total: 10, used: 0, pending: 0, carriedOut: 0, remaining: 10,
    });

    // Mon 23 to Fri 27 Nov minus Thanksgiving: 4 days.
    const week = await submitLeaveRequest(ctx, ana, { leaveTypeId: vac, startDate: "2026-11-23", endDate: "2026-11-27", dayPortion: "full" });
    const half = await submitLeaveRequest(ctx, ana, { leaveTypeId: vac, startDate: "2026-11-30", dayPortion: "am" });
    assert.deepEqual(await requestDaysOf(t.db, week.id), [{ year: 2026, days: 4 }]);
    assert.deepEqual(await requestDaysOf(t.db, half.id), [{ year: 2026, days: 0.5 }]);
    assert.deepEqual(await balanceOf(ctx, ana, vac), {
      tracked: true, allowance: 10, carriedOver: 0, adjustment: 0, total: 10, used: 0, pending: 4.5, carriedOut: 0, remaining: 5.5,
    });

    await decideLeaveRequest(ctx, boss, { requestId: week.id, decision: "approve" });
    const approved = await balanceOf(ctx, ana, vac);
    assert.ok(approved.tracked);
    assert.deepEqual([approved.used, approved.pending, approved.remaining], [4, 0.5, 5.5], "approval moves days, never adds");

    await decideLeaveRequest(ctx, boss, { requestId: half.id, decision: "reject" });
    const rejected = await balanceOf(ctx, ana, vac);
    assert.ok(rejected.tracked);
    assert.deepEqual([rejected.used, rejected.pending, rejected.remaining], [4, 0, 6]);

    await cancelLeaveRequest(ctx, ana, week.id);
    const cancelled = await balanceOf(ctx, ana, vac);
    assert.ok(cancelled.tracked);
    assert.deepEqual([cancelled.used, cancelled.pending, cancelled.remaining], [0, 0, 10]);

    // Other people's requests and other years never leak in.
    assert.equal((await balanceOf(ctx, boss, vac)).used, 0);
    assert.equal((await balanceOf(ctx, ana, vac, 2027)).used, 0);
  });

  test("an allowance row replaces the default and adds carryover and adjustment", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin", canSelfApprove: true } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10 });
    await setAllowance(t.db, { userId: co.people.boss.id, leaveTypeId: vac, year: 2026, days: 12, carriedOverDays: 3, adjustmentDays: -0.5 });
    const ctx = createTestContext(t.db);
    await submitLeaveRequest(ctx, co.people.boss, { leaveTypeId: vac, startDate: "2026-11-02", endDate: "2026-11-03", dayPortion: "full" });
    assert.deepEqual(await balanceOf(ctx, co.people.boss, vac), {
      tracked: true, allowance: 12, carriedOver: 3, adjustment: -0.5, total: 14.5, used: 2, pending: 0, carriedOut: 0, remaining: 12.5,
    });
  });

  test("a request over New Year counts in each year, fixed at submit: later holiday edits don't move past balances", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10 });
    await t.db.insert(schema.holidays).values({ companyId: co.companyId, date: "2027-01-01", name: "New Year" });
    const ctx = createTestContext(t.db);

    // Thu Dec 31 (2026) + Mon Jan 4 (2027); Jan 1 is a holiday, Jan 2-3 a weekend.
    const req = await submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: vac, startDate: "2026-12-31", endDate: "2027-01-04", dayPortion: "full" });
    assert.equal(req.days, 2);
    assert.deepEqual(await requestDaysOf(t.db, req.id), [
      { year: 2026, days: 1 },
      { year: 2027, days: 1 },
    ]);
    const pendingIn = async (year: number) => (await balanceOf(ctx, co.people.ana, vac, year)).pending;
    assert.deepEqual([await pendingIn(2026), await pendingIn(2027)], [1, 1]);

    await t.db.insert(schema.holidays).values({ companyId: co.companyId, date: "2026-12-31", name: "Added later" });
    assert.deepEqual([await pendingIn(2026), await pendingIn(2027)], [1, 1]);
    assert.equal((await requestsOf(t.db, co.people.ana.id))[0].days, 2);
  });

  test("submit refuses what a tracked balance can't cover, counting pending as spent; nothing is written", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 3 });
    const ctx = createTestContext(t.db);
    const ask = (startDate: string, endDate = startDate, dayPortion: "full" | "am" | "pm" = "full") =>
      submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: vac, startDate, endDate, dayPortion });

    await ask("2026-11-02", "2026-11-03");
    assert.deepEqual(await shortfallOf(ask("2026-11-09", "2026-11-10")), { year: 2026, requested: 2, remaining: 1, yearsSpanned: 1 });
    assert.equal((await requestsOf(t.db, co.people.ana.id)).length, 1);
    assert.equal(ctx.deferred(), 1, "only the first request's email was queued");

    // Exactly what is left still fits; then nothing does, not even half a day.
    await ask("2026-11-09");
    await rejectsWith(ask("2026-11-10", "2026-11-10", "pm"), "insufficient_balance");
    assert.equal((await requestsOf(t.db, co.people.ana.id)).length, 2);
  });

  test("self-approved requests are held to the same balance as routed ones", async () => {
    const co = await seedCompany(t.db, { owner: { role: "admin", canSelfApprove: true }, ana: { managerKey: "owner" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 1 });
    const ctx = createTestContext(t.db);
    const twoDays = { leaveTypeId: vac, startDate: "2026-11-02", endDate: "2026-11-03", dayPortion: "full" as const };

    for (const who of [co.people.owner, co.people.ana]) {
      assert.deepEqual(await shortfallOf(submitLeaveRequest(ctx, who, twoDays)), { year: 2026, requested: 2, remaining: 1, yearsSpanned: 1 });
      assert.equal((await requestsOf(t.db, who.id)).length, 0);
    }
    const events = await t.db.select().from(schema.eventsOutbox).where(eq(schema.eventsOutbox.companyId, co.companyId));
    assert.equal(events.length, 0);
    assert.equal((await submitLeaveRequest(ctx, co.people.owner, { ...twoDays, endDate: "" })).status, "approved");
  });

  test("a request over New Year is refused when either year falls short, naming that year", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 10 });
    await setAllowance(t.db, { userId: co.people.ana.id, leaveTypeId: vac, year: 2027, days: 1 });
    const ctx = createTestContext(t.db);
    const span = { leaveTypeId: vac, startDate: "2026-12-30", endDate: "2027-01-05", dayPortion: "full" as const };

    // Wed 30, Thu 31 in 2026; Fri 1, Mon 4, Tue 5 in 2027 (no New Year holiday here).
    assert.deepEqual(await shortfallOf(submitLeaveRequest(ctx, co.people.ana, span)), { year: 2027, requested: 3, remaining: 1, yearsSpanned: 2 });
    const fits = await submitLeaveRequest(ctx, co.people.ana, { ...span, endDate: "2027-01-01" });
    assert.deepEqual(await requestDaysOf(t.db, fits.id), [
      { year: 2026, days: 2 },
      { year: 2027, days: 1 },
    ]);
  });

  test("untracked types never block: no default and no row, or not counting against allowance", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin", canSelfApprove: true } });
    const unlimited = await addLeaveType(t.db, co.companyId, { code: "UNPAID", defaultAllowanceDays: null });
    const sick = await addLeaveType(t.db, co.companyId, { code: "SICK", defaultAllowanceDays: 0, countsAgainstAllowance: false });
    await setAllowance(t.db, { userId: co.people.boss.id, leaveTypeId: sick, year: 2026, days: 0 });
    const ctx = createTestContext(t.db);

    const a = await submitLeaveRequest(ctx, co.people.boss, { leaveTypeId: unlimited, startDate: "2026-11-02", endDate: "2026-11-13", dayPortion: "full" });
    const b = await submitLeaveRequest(ctx, co.people.boss, { leaveTypeId: sick, startDate: "2026-11-16", endDate: "2026-11-20", dayPortion: "full" });
    assert.deepEqual([a.days, b.days], [10, 5]);
    assert.deepEqual(await balanceOf(ctx, co.people.boss, unlimited), { tracked: false, used: 10, pending: 0 });
    assert.deepEqual(await balanceOf(ctx, co.people.boss, sick), { tracked: false, used: 5, pending: 0 });
  });

  test("concurrent submits cannot overspend: with 3 days left, exactly 3 of 6 one-day requests get through", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 3 });
    const ctx = createTestContext(t.db);
    const days = ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-07", "2026-12-08"];

    const results = await Promise.allSettled(
      days.map((startDate) => submitLeaveRequest(ctx, co.people.ana, { leaveTypeId: vac, startDate, dayPortion: "full" })),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    for (const r of results) {
      if (r.status === "rejected") assert.ok(isDomainError(r.reason, "insufficient_balance"), String(r.reason));
    }
    const balance = await balanceOf(ctx, co.people.ana, vac);
    assert.ok(balance.tracked);
    assert.deepEqual([balance.pending, balance.remaining], [3, 0]);
  });

  test("the preview runs submit's computation: same days, same remaining, same refusals, and it writes nothing", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 5 });
    const unlimited = await addLeaveType(t.db, co.companyId, { code: "UNPAID" });
    const ctx = createTestContext(t.db);
    const ana = co.people.ana;
    const week = { leaveTypeId: vac, startDate: "2026-11-23", endDate: "2026-11-27", dayPortion: "full" as const };

    assert.deepEqual(await previewLeaveRequest(ctx, ana, week), { days: 4, years: [{ year: 2026, days: 4, remainingAfter: 1 }] });
    assert.deepEqual(await previewLeaveRequest(ctx, ana, { ...week, leaveTypeId: unlimited }), {
      days: 4,
      years: [{ year: 2026, days: 4, remainingAfter: null }],
    });
    assert.equal((await requestsOf(t.db, ana.id)).length, 0);

    const submitted = await submitLeaveRequest(ctx, ana, week);
    assert.equal(submitted.days, 4);
    const left = await balanceOf(ctx, ana, vac);
    assert.ok(left.tracked);
    assert.equal(left.remaining, 1);

    // Each refusal is the one submit gives for the same input.
    const cases: [Parameters<typeof previewLeaveRequest>[2], string][] = [
      [{ ...week, startDate: "2026-11-07", endDate: "2026-11-08" }, "zero_days"],
      [{ ...week, startDate: "2026-11-27", endDate: "2026-11-30" }, "overlapping_request"],
      [{ ...week, startDate: "2026-11-30", endDate: "2026-12-01" }, "insufficient_balance"],
      [{ ...week, startDate: "2026-11-30", endDate: "2026-11-29" }, "invalid_date_range"],
      [{ ...week, leaveTypeId: co.archived }, "leave_type_unavailable"],
      [{ ...week, leaveTypeId: "nope" }, "leave_type_unavailable"],
      [{ ...week, startDate: "2026-11-30", endDate: "2026-12-01", dayPortion: "am" }, "half_day_multi_day"],
    ];
    for (const [draft, code] of cases) {
      await rejectsWith(previewLeaveRequest(ctx, ana, draft), code as never);
      await rejectsWith(submitLeaveRequest(ctx, ana, draft), code as never);
    }
    assert.equal((await requestsOf(t.db, ana.id)).length, 1);
  });

  test("an unknown allowance policy fails loudly on submit and preview; the dashboard still renders without balances", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin", canSelfApprove: true } });
    await t.db.update(schema.companies).set({ allowancePolicy: "accrual_monthly" }).where(eq(schema.companies.id, co.companyId));
    const ctx = createTestContext(t.db);
    const draft = { leaveTypeId: co.pto, startDate: "2026-11-02", dayPortion: "full" as const };

    await rejectsWith(submitLeaveRequest(ctx, co.people.boss, draft), "policy_unavailable");
    await rejectsWith(previewLeaveRequest(ctx, co.people.boss, draft), "policy_unavailable");
    assert.equal((await requestsOf(t.db, co.people.boss.id)).length, 0);

    const stderr = process.stderr.write.bind(process.stderr);
    const logged: string[] = [];
    process.stderr.write = ((chunk: string) => (logged.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const dash = await getDashboard(ctx, co.people.boss);
      assert.equal(dash.balances, null);
      assert.deepEqual(dash.leaveTypes.map((lt) => lt.id), [co.pto]);
    } finally {
      process.stderr.write = stderr;
    }
    assert.ok(logged.some((l) => l.includes('"event":"allowance_policy_unavailable"')));
  });

  test("the dashboard summarises every active type for the company's current year, in a fixed number of queries", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin", canSelfApprove: true } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 30, sortOrder: 1 });
    await addLeaveType(t.db, co.companyId, { code: "GONE", defaultAllowanceDays: 5, archived: true });

    let queries = 0;
    const counting = t.withLogger({ logQuery: () => void queries++ });
    const queriesFor = async (now: Date) => {
      queries = 0;
      const dash = await getDashboard(createTestContext(counting, { now }), co.people.boss);
      return { queries, dash };
    };

    const empty = await queriesFor(new Date("2026-11-01T15:00:00Z"));
    // Many approved requests, written directly (submit is rate limited per person).
    const boss = co.people.boss;
    const weekdays = (month: string, days: number[]) => days.map((d) => `2026-${month}-${String(d).padStart(2, "0")}`);
    const book = async (leaveTypeId: string, dates: string[]) => {
      for (const date of dates) {
        const [req] = await t.db
          .insert(schema.leaveRequests)
          .values({ companyId: co.companyId, userId: boss.id, leaveTypeId, startDate: date, endDate: date, days: 1, status: "approved", approverId: boss.id })
          .returning();
        await t.db.insert(schema.leaveRequestDays).values({ requestId: req.id, year: 2026, days: 1 });
      }
    };
    await book(vac, weekdays("11", [2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20]));
    await book(co.pto, weekdays("12", [1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 21]));
    const busy = await queriesFor(new Date("2026-11-01T15:00:00Z"));
    assert.equal(empty.queries, 6, "settings, types, requests, allowances, booked days, holidays");
    assert.equal(busy.queries, empty.queries, "query count does not grow with requests");

    assert.ok(busy.dash.balances);
    assert.equal(busy.dash.balances.year, 2026);
    assert.deepEqual(
      busy.dash.balances.items.map((i) => [i.name, i.balance]),
      [
        ["PTO", { tracked: false, used: 15, pending: 0 }],
        ["VAC", { tracked: true, allowance: 30, carriedOver: 0, adjustment: 0, total: 30, used: 15, pending: 0, carriedOut: 0, remaining: 15 }],
      ],
    );

    // New Year's Eve evening in Chicago is still 2026 there, though 2027 in UTC.
    const eve = await queriesFor(new Date("2027-01-01T03:00:00Z"));
    assert.equal(eve.dash.balances?.year, 2026);
    const newYear = await queriesFor(new Date("2027-01-01T07:00:00Z"));
    assert.equal(newYear.dash.balances?.year, 2027);
    assert.equal(newYear.dash.balances?.items[1].balance.used, 0);
  });

  test("submitting records the leave events as before; balances add no event of their own", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const vac = await addLeaveType(t.db, co.companyId, { code: "VAC", defaultAllowanceDays: 5 });
    const req = await submitLeaveRequest(createTestContext(t.db), co.people.ana, { leaveTypeId: vac, startDate: "2026-11-02", dayPortion: "full" });
    assert.deepEqual((await eventsFor(t.db, co.companyId, req.id)).map((e) => e.type), ["leave.requested"]);
  });
});

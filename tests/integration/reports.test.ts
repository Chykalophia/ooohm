import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import { isDomainError } from "@/domain/errors";
import { exportLeaveReport, getLeaveReport } from "@/server/services/reports";
import { addLeaveType, seedCompany, setAllowance } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

// The test clock is 2026-11-01 15:00 UTC: Nov 1 in Chicago, so the report's year is 2026.

describe("reports", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  type Leave = { userId: string; leaveTypeId: string; start: string; end: string; status?: "approved" | "pending" | "rejected" | "cancelled"; split: [number, number][] };

  async function addLeave(db: Database, companyId: string, l: Leave) {
    const [row] = await db
      .insert(schema.leaveRequests)
      .values({
        companyId,
        userId: l.userId,
        leaveTypeId: l.leaveTypeId,
        startDate: l.start,
        endDate: l.end,
        days: l.split.reduce((s, [, d]) => s + d, 0),
        status: l.status ?? "approved",
        note: "private note",
      })
      .returning();
    await db.insert(schema.leaveRequestDays).values(l.split.map(([year, days]) => ({ requestId: row.id, year, days })));
    return row.id;
  }

  async function seeded() {
    const co = await seedCompany(t.db, {
      boss: { role: "admin" },
      mo: { role: "manager" },
      ana: { managerKey: "mo" },
      bo: { managerKey: "mo" },
      cy: {},
      gone: { isActive: false, managerKey: "mo" },
    });
    const { ana, bo, cy, gone } = co.people;
    const [dev] = await t.db.insert(schema.departments).values({ companyId: co.companyId, name: "Dev" }).returning();
    await t.db.update(schema.user).set({ departmentId: dev.id }).where(eq(schema.user.id, ana.id));
    const sick = await addLeaveType(t.db, co.companyId, { code: "SICK" });
    await t.db.update(schema.leaveTypes).set({ defaultAllowanceDays: 20 }).where(eq(schema.leaveTypes.id, co.pto));
    await setAllowance(t.db, { userId: ana.id, leaveTypeId: co.pto, year: 2026, days: 25 });

    await addLeave(t.db, co.companyId, { userId: ana.id, leaveTypeId: co.pto, start: "2026-03-02", end: "2026-03-06", split: [[2026, 5]] });
    await addLeave(t.db, co.companyId, { userId: ana.id, leaveTypeId: co.pto, start: "2026-12-07", end: "2026-12-08", status: "pending", split: [[2026, 2]] });
    await addLeave(t.db, co.companyId, { userId: bo.id, leaveTypeId: sick, start: "2026-10-29", end: "2026-11-03", split: [[2026, 4]] });
    await addLeave(t.db, co.companyId, { userId: cy.id, leaveTypeId: co.pto, start: "2026-06-01", end: "2026-06-03", split: [[2026, 3]] });
    await addLeave(t.db, co.companyId, { userId: cy.id, leaveTypeId: co.pto, start: "2025-12-31", end: "2026-01-02", split: [[2025, 1], [2026, 2]] });
    await addLeave(t.db, co.companyId, { userId: gone.id, leaveTypeId: co.pto, start: "2025-07-07", end: "2025-07-08", split: [[2025, 2]] });
    await addLeave(t.db, co.companyId, { userId: ana.id, leaveTypeId: co.pto, start: "2026-05-04", end: "2026-05-04", status: "rejected", split: [[2026, 1]] });
    return { co, dev, sick, ctx: createTestContext(t.db) };
  }

  test("an admin sees the whole company: totals, months, trend, types, departments and balances", async () => {
    const { co, ctx } = await seeded();
    const { report, nav } = await getLeaveReport(ctx, co.people.boss, {});
    assert.equal(nav.year, 2026);
    assert.equal(nav.current, 2026);
    // ana 5 + bo 4 + cy 3 + cy's 2026 part 2.
    assert.equal(report.totals.approvedDays, 14);
    assert.equal(report.totals.pendingDays, 2);
    assert.equal(report.totals.requests.rejected, 1);
    assert.equal(report.totals.headcount, 5);
    assert.equal(report.months[2].total, 5, "March");
    assert.equal(report.months[9].total, 2, "Oct 29 and 30");
    assert.equal(report.months[10].total, 2, "Nov 2 and 3");
    assert.equal(report.months[0].total, 2, "Jan 1 and 2");
    assert.equal(report.previousYearMonths[6], 2, "gone's July 2025 still counts in history");
    assert.deepEqual(
      report.trend.map((y) => y.days),
      [0, 0, 0, 3, 14],
    );
    assert.deepEqual(
      report.byType.map((t) => [t.name, t.days]),
      [
        ["PTO", 10],
        ["SICK", 4],
      ],
    );
    assert.deepEqual(
      report.byDepartment.map((d) => [d.name, d.days]),
      [
        ["Dev", 5],
        ["No department", 9],
      ],
    );
    assert.equal(report.showsBalances, true);
    const ana = report.people.find((p) => p.name === "Ana");
    // 25 - 5 used - 2 pending; SICK has no allowance, so it is not tracked.
    assert.equal(ana?.remaining, 18);
    assert.equal(report.people.find((p) => p.name === "Gone"), undefined, "inactive, and nothing in 2026");
    assert.ok(!JSON.stringify(report).includes("private note"));
  });

  test("a manager sees only their direct reports, without balances when the company keeps them private", async () => {
    const { co, ctx } = await seeded();
    const { report } = await getLeaveReport(ctx, co.people.mo, { year: 2026 });
    assert.deepEqual(
      report.people.map((p) => p.name),
      ["Ana", "Bo"],
    );
    assert.equal(report.totals.approvedDays, 9);
    assert.equal(report.showsBalances, true, "managers see their team's balances by default");

    await t.db.update(schema.companies).set({ managersSeeDetails: false }).where(eq(schema.companies.id, co.companyId));
    const hidden = await getLeaveReport(ctx, co.people.mo, { year: 2026 });
    assert.equal(hidden.report.showsBalances, false);
    assert.ok(hidden.report.people.every((p) => p.remaining === null));
  });

  test("employees get not_found", async () => {
    const { co, ctx } = await seeded();
    await assert.rejects(getLeaveReport(ctx, co.people.ana, {}), (err) => isDomainError(err, "not_found"));
    await assert.rejects(exportLeaveReport(ctx, co.people.ana, {}), (err) => isDomainError(err, "not_found"));
  });

  test("a department narrows the report; an unknown one, or another company's, means everyone", async () => {
    const { co, dev, ctx } = await seeded();
    const narrowed = await getLeaveReport(ctx, co.people.boss, { departmentId: dev.id });
    assert.equal(narrowed.department?.name, "Dev");
    assert.deepEqual(
      narrowed.report.people.map((p) => p.name),
      ["Ana"],
    );
    const other = await seeded();
    const fallback = await getLeaveReport(ctx, co.people.boss, { departmentId: other.dev.id });
    assert.equal(fallback.department, null);
    assert.equal(fallback.report.totals.approvedDays, 14, "the other company's identical leave never adds in");
  });

  test("an earlier year, and a year out of range falls back to this one", async () => {
    const { co, ctx } = await seeded();
    const last = await getLeaveReport(ctx, co.people.boss, { year: 2025 });
    assert.equal(last.report.totals.approvedDays, 3);
    assert.equal(last.report.people.find((p) => p.name === "Gone")?.approvedDays, 2);
    const odd = await getLeaveReport(ctx, co.people.boss, { year: 99999 });
    assert.equal(odd.nav.year, 2026);
  });

  test("the same number of queries for any amount of leave", async () => {
    const { co } = await seeded();
    let queries = 0;
    const db = t.withLogger({ logQuery: () => void queries++ });
    await getLeaveReport(createTestContext(db), co.people.boss, {});
    assert.equal(queries, 9, "company, departments, leave types, people; then leave, holidays, and the three balance reads (allowances, booked days, allowance defaults)");
    queries = 0;
    await t.db.update(schema.companies).set({ managersSeeDetails: false }).where(eq(schema.companies.id, co.companyId));
    await getLeaveReport(createTestContext(db), co.people.mo, {});
    assert.equal(queries, 6, "no balance reads when balances are hidden");
  });

  test("the CSV export: one row per person, named for the year", async () => {
    const { co, ctx } = await seeded();
    const { filename, csv } = await exportLeaveReport(ctx, co.people.boss, { year: 2026 });
    assert.equal(filename, "ooohm-leave-report-2026.csv");
    const lines = csv.trimEnd().split("\r\n");
    assert.equal(lines[0], "Person,Department,Active,PTO,SICK,Approved days,Pending days,Days left");
    assert.ok(lines.includes("Ana,Dev,yes,5,0,5,2,18"));
    assert.ok(!csv.includes("private note"));
  });
});

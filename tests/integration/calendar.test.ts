import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db/types";
import type { Actor } from "@/domain/actor";
import type { LeaveStatus } from "@/domain/leave-request";
import { violatedConstraint } from "@/server/repositories/errors";
import { getMonthCalendar, getTeamCalendar, getYearCalendar } from "@/server/services/calendar";
import { seedCompany } from "./fixtures";
import { createTestContext, createTestDatabase, skip, type TestDatabase } from "./harness";

// The test clock is 2026-11-01 15:00 UTC: Nov 1 in Chicago, so "this month" is 2026-11.
// 2026-11-02 is a Monday; Thanksgiving (Thu 2026-11-26) is the seeded holiday.

interface Booking {
  startDate: string;
  endDate?: string;
  status?: LeaveStatus;
  dayPortion?: "full" | "am" | "pm";
  note?: string | null;
  decisionNote?: string | null;
}

/** Writes requests directly (submit is rate limited per person), with notes to prove they never leak. */
async function book(db: Database, companyId: string, userId: string, leaveTypeId: string, bookings: Booking[]) {
  if (bookings.length === 0) return [];
  return db
    .insert(schema.leaveRequests)
    .values(
      bookings.map((b) => ({
        companyId,
        userId,
        leaveTypeId,
        startDate: b.startDate,
        endDate: b.endDate ?? b.startDate,
        dayPortion: b.dayPortion ?? "full",
        days: b.dayPortion && b.dayPortion !== "full" ? 0.5 : 1,
        status: b.status ?? "approved",
        note: b.note ?? null,
        decisionNote: b.decisionNote ?? null,
      })),
    )
    .returning();
}

/** A drizzle handle on the same pool that counts every query it runs. */
function countingDb(t: TestDatabase) {
  let queries = 0;
  const db = t.withLogger({ logQuery: () => void queries++ });
  return {
    db,
    async count<T>(work: (db: Database) => Promise<T>): Promise<{ queries: number; result: T }> {
      queries = 0;
      const result = await work(db);
      return { queries, result };
    },
  };
}

/** Every key anywhere in a value, to prove a field is absent at any depth. */
function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe("calendar views", { skip }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test("month view: my approved and pending leave, half days, holidays; never rejected, cancelled or anyone else's", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const { ana, boss } = co.people;
    const [approved, pending, half] = await book(t.db, co.companyId, ana.id, co.pto, [
      { startDate: "2026-11-23", endDate: "2026-11-27" },
      { startDate: "2026-11-10", status: "pending" },
      { startDate: "2026-11-12", dayPortion: "am" },
      { startDate: "2026-11-16", status: "rejected" },
      { startDate: "2026-11-17", status: "cancelled" },
    ]);
    await book(t.db, co.companyId, boss.id, co.pto, [{ startDate: "2026-11-18" }]);

    const counter = countingDb(t);
    const { queries, result } = await counter.count((db) => getMonthCalendar(createTestContext(db), ana, "2026-11"));
    assert.equal(queries, 4, "settings, then holidays, leave and leave types");
    assert.deepEqual(result.leaveTypes.map((t) => t.id), [co.pto], "active leave types, for asking from the month");

    assert.deepEqual(result.nav, { month: "2026-11", today: "2026-11-01", previous: "2026-10", next: "2026-12", current: "2026-11" });
    const days = result.weeks.flat();
    const on = (date: string) => days.find((d) => d.date === date)!;
    assert.deepEqual(
      days.filter((d) => d.entries.length > 0).map((d) => [d.date, d.entries.map((e) => [e.id, e.status, e.dayPortion])]),
      [
        ["2026-11-10", [[pending.id, "pending", "full"]]],
        ["2026-11-12", [[half.id, "approved", "am"]]],
        ["2026-11-23", [[approved.id, "approved", "full"]]],
        ["2026-11-24", [[approved.id, "approved", "full"]]],
        ["2026-11-25", [[approved.id, "approved", "full"]]],
        // Thanksgiving (26th) costs nothing, so the request does not show on it.
        ["2026-11-27", [[approved.id, "approved", "full"]]],
      ],
    );
    assert.equal(on("2026-11-26").holiday, "Thanksgiving");
    assert.equal(on("2026-11-01").isToday, true);
    assert.equal(on("2026-11-07").isWorkingDay, false);
    assert.deepEqual(
      result.agenda.map((i) => (i.kind === "holiday" ? i.name : i.entry.id)),
      [pending.id, half.id, approved.id, "Thanksgiving"],
    );
  });

  test("month view: a malformed or missing month falls back to this month; any real month is reachable", async () => {
    const co = await seedCompany(t.db, { ana: { role: "admin" } });
    const ctx = createTestContext(t.db);
    for (const month of [undefined, "2026-13", "nonsense", "2026-1", "3000-01"]) {
      const { nav } = await getMonthCalendar(ctx, co.people.ana, month);
      assert.equal(nav.month, "2026-11", String(month));
    }
    const jan = await getMonthCalendar(ctx, co.people.ana, "2027-01");
    assert.deepEqual([jan.nav.month, jan.nav.previous, jan.nav.next], ["2027-01", "2026-12", "2027-02"]);
    assert.equal(jan.weeks.flat().filter((d) => d.isToday).length, 0);
  });

  test("year view: twelve months of my leave in three queries; a bad year falls back to this one", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: { managerKey: "boss" } });
    const { ana, boss } = co.people;
    const [jan, nov] = await book(t.db, co.companyId, ana.id, co.pto, [
      { startDate: "2026-01-05", endDate: "2026-01-06" },
      { startDate: "2026-11-10", status: "pending" },
      { startDate: "2026-12-14", status: "cancelled" },
    ]);
    await book(t.db, co.companyId, boss.id, co.pto, [{ startDate: "2026-03-02" }]);

    const counter = countingDb(t);
    const { queries, result } = await counter.count((db) => getYearCalendar(createTestContext(db), ana, 2026));
    assert.equal(queries, 3, "settings, then holidays and leave");
    assert.deepEqual(result.nav, { year: 2026, today: "2026-11-01", current: 2026 });
    assert.deepEqual(result.months.map((m) => m.month).slice(0, 2), ["2026-01", "2026-02"]);
    assert.equal(result.months.length, 12);
    const leave = result.months.flatMap((m) => m.agenda.filter((i) => i.kind === "leave").map((i) => [m.month, i.kind === "leave" && i.entry.id]));
    assert.deepEqual(leave, [
      ["2026-01", jan.id],
      ["2026-11", nov.id],
    ]);
    const novDays = result.months[10].weeks.flat();
    assert.equal(novDays.find((d) => d.date === "2026-11-26")?.holiday, "Thanksgiving");

    for (const year of [undefined, 1899, 3000, 2026.5]) {
      assert.equal((await getYearCalendar(createTestContext(t.db), ana, year)).nav.year, 2026, String(year));
    }
  });

  test("who's out with 50 people: a fixed four queries, the right people and leave, and nobody's notes", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" } });
    const [eng, sales] = await t.db
      .insert(schema.departments)
      .values([
        { companyId: co.companyId, name: "Engineering" },
        { companyId: co.companyId, name: "Sales" },
      ])
      .returning();
    const viewer: Actor = co.people.boss;
    const counter = countingDb(t);
    const view = (db: Database, departmentId?: string) => getTeamCalendar(createTestContext(db), viewer, { month: "2026-11", departmentId });

    const empty = await counter.count((db) => view(db));
    assert.equal(empty.queries, 4, "settings and departments, then holidays and one range query");
    assert.deepEqual(empty.result.people, []);

    const people = Array.from({ length: 50 }, (_, i) => ({
      id: randomUUID(),
      name: `Person ${String(i).padStart(2, "0")}`,
      email: `p${i}-${randomUUID().slice(0, 8)}@example.com`,
      companyId: co.companyId,
      departmentId: i % 2 === 0 ? eng.id : sales.id,
    }));
    await t.db.insert(schema.user).values(people);
    const expected = new Map<string, { id: string; status: LeaveStatus }[]>();
    for (const [i, p] of people.entries()) {
      const day = String(2 + (i % 20)).padStart(2, "0");
      const rows = await book(t.db, co.companyId, p.id, co.pto, [
        { startDate: `2026-11-${day}`, note: `SECRET-NOTE-${i}`, decisionNote: `SECRET-DECISION-${i}` },
        { startDate: "2026-11-30", status: "pending", dayPortion: "pm", note: `SECRET-NOTE-P${i}` },
        // Straddles into the month from October: shown.
        { startDate: "2026-10-29", endDate: "2026-11-02", note: `SECRET-NOTE-O${i}` },
        { startDate: "2026-11-20", status: "rejected", decisionNote: `SECRET-DECISION-R${i}` },
        { startDate: "2026-11-19", status: "cancelled" },
        { startDate: "2026-12-01" },
        { startDate: "2026-10-01", endDate: "2026-10-30" },
      ]);
      // Nov 7, 8, 14, 15 and 21 are weekends: a single day there costs nothing, so it is not "out".
      const onWeekend = ["07", "08", "14", "15", "21"].includes(day);
      expected.set(p.id, [
        { id: rows[2].id, status: "approved" },
        ...(onWeekend ? [] : [{ id: rows[0].id, status: "approved" as const }]),
        { id: rows[1].id, status: "pending" },
      ]);
    }
    // Neither a deactivated member nor another company shows.
    const [inactive] = await t.db
      .insert(schema.user)
      .values({ id: randomUUID(), name: "Gone", email: `gone-${randomUUID().slice(0, 8)}@example.com`, companyId: co.companyId, isActive: false })
      .returning();
    await book(t.db, co.companyId, inactive.id, co.pto, [{ startDate: "2026-11-03" }]);
    const other = await seedCompany(t.db, { stranger: {} });
    await book(t.db, other.companyId, other.people.stranger.id, other.pto, [{ startDate: "2026-11-03" }]);

    const busy = await counter.count((db) => view(db));
    assert.equal(busy.queries, empty.queries, "query count does not grow with people or requests");

    const result = busy.result;
    assert.equal(result.people.length, 50);
    assert.deepEqual(
      result.people.map((p) => p.personName),
      people.map((p) => p.name),
      "everyone with leave, by name",
    );
    for (const person of result.people) {
      assert.deepEqual(
        person.entries.map((e) => ({ id: e.id, status: e.status })),
        expected.get(person.userId),
        person.personName,
      );
      assert.equal(person.departmentName, people.find((p) => p.id === person.userId)!.departmentId === eng.id ? "Engineering" : "Sales");
    }
    const first = result.people[0].entries.find((e) => e.status === "pending")!;
    assert.deepEqual(
      { dayPortion: first.dayPortion, code: first.leaveTypeCode, name: first.leaveTypeName },
      { dayPortion: "pm", code: "PTO", name: "PTO" },
    );

    // Privacy: no note, decision note or balance anywhere in what the page receives.
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("SECRET"), "no note or decision note text");
    const keys = keysDeep(result);
    for (const key of ["note", "decisionNote", "approverId", "days", "balance", "personEmail"]) assert.ok(!keys.has(key), key);

    const filtered = await counter.count((db) => view(db, eng.id));
    assert.equal(filtered.queries, 4);
    assert.equal(filtered.result.department?.name, "Engineering");
    assert.deepEqual(
      filtered.result.people.map((p) => p.personName),
      people.filter((p) => p.departmentId === eng.id).map((p) => p.name),
    );

    // Another company's department, or garbage, falls back to everyone.
    const [foreign] = await t.db.insert(schema.departments).values({ companyId: other.companyId, name: "Elsewhere" }).returning();
    for (const departmentId of [foreign.id, "not-a-uuid"]) {
      const res = await view(t.db, departmentId);
      assert.equal(res.department, null);
      assert.equal(res.people.length, 50);
    }
  });

  test("who's out labels a person with a blank name by their email's local part, and follows a deactivation at once", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
    await t.db.update(schema.user).set({ name: "  " }).where(eq(schema.user.id, co.people.ana.id));
    await book(t.db, co.companyId, co.people.ana.id, co.pto, [{ startDate: "2026-11-03" }]);
    const ctx = createTestContext(t.db);
    const view = () => getTeamCalendar(ctx, co.people.boss, { month: "2026-11" });

    assert.deepEqual((await view()).people.map((p) => p.personName), [co.people.ana.email.split("@")[0]]);
    assert.ok(!JSON.stringify((await view()).people).includes(co.people.ana.email), "never the full address");
    await t.db.update(schema.user).set({ isActive: false }).where(eq(schema.user.id, co.people.ana.id));
    assert.deepEqual((await view()).people, []);
  });
  test("who's out: leave that only covers a month's weekend is not out that month; its weekdays' month still shows it", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {}, ben: {} });
    const ctx = createTestContext(t.db);
    // Thu Oct 29 to Sun Nov 1: November holds only the Sunday.
    const [thuToSun] = await book(t.db, co.companyId, co.people.ana.id, co.pto, [{ startDate: "2026-10-29", endDate: "2026-11-01" }]);
    // Thanksgiving alone costs nothing; with the Friday after, it costs a day.
    await book(t.db, co.companyId, co.people.ben.id, co.pto, [{ startDate: "2026-11-26" }]);
    const [withFriday] = await book(t.db, co.companyId, co.people.boss.id, co.pto, [{ startDate: "2026-11-26", endDate: "2026-11-27" }]);

    const nov = await getTeamCalendar(ctx, co.people.boss, { month: "2026-11" });
    assert.deepEqual(
      nov.people.map((p) => [p.personName, p.entries.map((e) => e.id)]),
      [["Boss", [withFriday.id]]],
    );
    const oct = await getTeamCalendar(ctx, co.people.boss, { month: "2026-10" });
    assert.deepEqual(oct.people.map((p) => [p.personName, p.entries.map((e) => e.id)]), [["Ana", [thuToSun.id]]]);

    // Ana's own month view: the phone agenda agrees with the grid in both months.
    const mine = await getMonthCalendar(ctx, co.people.ana, "2026-11");
    assert.deepEqual(mine.agenda.filter((i) => i.kind === "leave"), []);
    assert.deepEqual(mine.weeks.flat().filter((d) => d.inMonth && d.entries.length > 0), []);
    const mineOct = await getMonthCalendar(ctx, co.people.ana, "2026-10");
    assert.deepEqual(mineOct.agenda.map((i) => i.kind === "leave" && i.entry.id), [thuToSun.id]);
  });

  test("a request of the longest allowed span still shows at its far end, and a longer one cannot exist", async () => {
    const co = await seedCompany(t.db, { boss: { role: "admin" }, ana: {} });
    const ctx = createTestContext(t.db);
    // Each starts exactly at the scan's lower bound (366 days before the range's first
    // day) and ends on that first day, so both edges of the bound are exercised.
    // December's team range starts Tue 2026-12-01; November's grid starts Mon 2026-10-26.
    const [toDecember, toGrid] = await book(t.db, co.companyId, co.people.ana.id, co.pto, [
      { startDate: "2025-12-01", endDate: "2026-12-01" },
      { startDate: "2025-10-26", endDate: "2026-10-26" },
    ]);
    const dec = await getTeamCalendar(ctx, co.people.boss, { month: "2026-12" });
    assert.deepEqual(dec.people.map((p) => p.entries.map((e) => e.id)), [[toDecember.id]]);
    const mine = await getMonthCalendar(ctx, co.people.ana, "2026-11");
    const firstGridDay = mine.weeks[0][0];
    assert.equal(firstGridDay.date, "2026-10-26");
    assert.ok(firstGridDay.entries.some((e) => e.id === toGrid.id));

    await assert.rejects(
      book(t.db, co.companyId, co.people.ana.id, co.pto, [{ startDate: "2025-11-04", endDate: "2026-11-05" }]),
      (err: unknown) => violatedConstraint(err) === "leave_requests_span_max",
      "367 days is refused by the database, so the scan's lower bound never hides a request",
    );
  });
});

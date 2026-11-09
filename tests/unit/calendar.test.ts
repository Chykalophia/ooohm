import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addMonths,
  agendaForDay,
  buildAgenda,
  buildMonthGrid,
  type CalendarEntry,
  entriesCostingDaysIn,
  groupByPerson,
  isYearMonth,
  monthBounds,
  monthGridBounds,
  type TeamCalendarEntry,
} from "@/domain/calendar";

let seq = 0;
function entry(startDate: string, endDate = startDate, overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  seq++;
  return {
    id: `r${String(seq).padStart(3, "0")}`,
    userId: "u1",
    startDate,
    endDate,
    dayPortion: "full",
    status: "approved",
    leaveTypeName: "PTO",
    leaveTypeCode: "PTO",
    leaveTypeColor: "#0f766e",
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

describe("months", () => {
  test("only real YYYY-MM months in a sane year range are accepted", () => {
    for (const ok of ["2026-11", "2026-01", "2026-12", "1900-01", "2999-12"]) assert.ok(isYearMonth(ok), ok);
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", "", "1899-12", "3000-01", " 2026-11", "2026-11\n"]) {
      assert.ok(!isYearMonth(bad), JSON.stringify(bad));
    }
  });

  test("months add across year ends in both directions", () => {
    assert.equal(addMonths("2026-11", 1), "2026-12");
    assert.equal(addMonths("2026-12", 1), "2027-01");
    assert.equal(addMonths("2026-01", -1), "2025-12");
    assert.equal(addMonths("2026-03", -15), "2024-12");
    assert.equal(addMonths("2026-11", 18), "2028-05");
  });

  test("month bounds know month lengths and leap years", () => {
    assert.deepEqual(monthBounds("2026-11"), { first: "2026-11-01", last: "2026-11-30" });
    assert.deepEqual(monthBounds("2026-02"), { first: "2026-02-01", last: "2026-02-28" });
    assert.deepEqual(monthBounds("2028-02"), { first: "2028-02-01", last: "2028-02-29" });
    assert.deepEqual(monthBounds("2026-12"), { first: "2026-12-01", last: "2026-12-31" });
  });

  test("the grid covers whole Monday-to-Sunday weeks around the month", () => {
    // Nov 1 2026 is a Sunday and Nov 30 a Monday: six weeks.
    assert.deepEqual(monthGridBounds("2026-11"), { start: "2026-10-26", end: "2026-12-06" });
    // Feb 2027 starts on a Monday and ends on a Sunday: exactly four weeks.
    assert.deepEqual(monthGridBounds("2027-02"), { start: "2027-02-01", end: "2027-02-28" });
  });
});

describe("month grid", () => {
  const base = {
    month: "2026-11",
    today: "2026-11-04",
    workingDays: [1, 2, 3, 4, 5],
    holidays: [{ date: "2026-11-26", name: "Thanksgiving" }],
  };

  test("weeks of seven days, flags for the month, today, working days and holidays", () => {
    const weeks = buildMonthGrid({ ...base, entries: [] });
    assert.equal(weeks.length, 6);
    assert.ok(weeks.every((w) => w.length === 7));
    const days = weeks.flat();
    const day = (date: string) => days.find((d) => d.date === date)!;
    assert.equal(days[0].date, "2026-10-26");
    assert.equal(day("2026-10-31").inMonth, false);
    assert.equal(day("2026-11-01").inMonth, true);
    assert.equal(day("2026-11-04").isToday, true);
    assert.equal(days.filter((d) => d.isToday).length, 1);
    assert.equal(day("2026-11-07").isWorkingDay, false, "Saturday");
    assert.equal(day("2026-11-09").isWorkingDay, true, "Monday");
    assert.equal(day("2026-11-26").holiday, "Thanksgiving");
    assert.equal(day("2026-11-25").holiday, null);
  });

  test("leave shows on the days it costs: not on weekends or holidays inside its range", () => {
    // Fri Nov 20 to Fri Nov 27: the weekend and Thanksgiving cost nothing.
    const week = entry("2026-11-20", "2026-11-27");
    const days = buildMonthGrid({ ...base, entries: [week] }).flat();
    const shown = days.filter((d) => d.entries.length > 0).map((d) => d.date);
    assert.deepEqual(shown, ["2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"]);
  });

  test("a company working weekends shows leave on them", () => {
    const sat = entry("2026-11-07");
    const days = buildMonthGrid({ ...base, workingDays: [1, 2, 3, 4, 5, 6], entries: [sat] }).flat();
    assert.deepEqual(days.find((d) => d.date === "2026-11-07")!.entries, [sat]);
  });

  test("approved and pending show; rejected and cancelled never do", () => {
    const approved = entry("2026-11-10");
    const pending = entry("2026-11-10", "2026-11-10", { status: "pending", dayPortion: "pm" });
    const rejected = entry("2026-11-10", "2026-11-10", { status: "rejected" });
    const cancelled = entry("2026-11-10", "2026-11-10", { status: "cancelled" });
    const day = buildMonthGrid({ ...base, entries: [rejected, pending, cancelled, approved] })
      .flat()
      .find((d) => d.date === "2026-11-10")!;
    assert.deepEqual(day.entries, [approved, pending]);
  });

  test("a morning comes before an afternoon on the same day", () => {
    const pm = entry("2026-11-11", "2026-11-11", { dayPortion: "pm", id: "a" });
    const am = entry("2026-11-11", "2026-11-11", { dayPortion: "am", id: "b" });
    const day = buildMonthGrid({ ...base, entries: [pm, am] }).flat().find((d) => d.date === "2026-11-11")!;
    assert.deepEqual(day.entries.map((e) => e.dayPortion), ["am", "pm"]);
  });

  test("leave on the neighbouring months' days in the grid shows there too", () => {
    const late = entry("2026-10-29", "2026-11-02");
    const days = buildMonthGrid({ ...base, entries: [late] }).flat();
    assert.deepEqual(
      days.filter((d) => d.entries.length > 0).map((d) => [d.date, d.inMonth]),
      [["2026-10-29", false], ["2026-10-30", false], ["2026-11-02", true]],
    );
  });
});

describe("agenda", () => {
  test("each request touching the month once, and the month's holidays, in date order", () => {
    const fromOctober = entry("2026-10-28", "2026-11-03");
    const inside = entry("2026-11-26", "2026-11-27", { status: "pending" });
    const december = entry("2026-12-01");
    const rejected = entry("2026-11-10", "2026-11-10", { status: "rejected" });
    const items = buildAgenda({
      month: "2026-11",
      workingDays: [1, 2, 3, 4, 5],
      holidays: [
        { date: "2026-11-26", name: "Thanksgiving" },
        { date: "2026-12-25", name: "Christmas" },
      ],
      entries: [december, inside, rejected, fromOctober],
    });
    assert.deepEqual(
      items.map((i) => (i.kind === "holiday" ? `holiday ${i.name}` : `leave ${i.entry.id}`)),
      [`leave ${fromOctober.id}`, "holiday Thanksgiving", `leave ${inside.id}`],
    );
  });

  test("one day of it lists what the grid shows that day: its leave and its holiday, never a weekend in between", () => {
    const input = {
      month: "2026-11" as const,
      today: "2026-11-01",
      workingDays: [1, 2, 3, 4, 5],
      holidays: [{ date: "2026-11-26", name: "Thanksgiving" }],
      entries: [entry("2026-11-05", "2026-11-09"), entry("2026-11-09"), entry("2026-11-25", "2026-11-27")],
    };
    const [fiveToNine, ninth, thanksgivingWeek] = input.entries;
    const agenda = buildAgenda(input);
    const day = (date: string) => buildMonthGrid(input).flat().find((d) => d.date === date)!;
    const on = (date: string) => agendaForDay(agenda, day(date)).map((i) => (i.kind === "holiday" ? i.name : i.entry.id));
    assert.deepEqual(on("2026-11-09"), [fiveToNine.id, ninth.id]);
    assert.deepEqual(on("2026-11-07"), [], "a Saturday inside leave costs nothing, so it lists nothing");
    assert.deepEqual(on("2026-11-26"), ["Thanksgiving"], "leave never counts on a holiday");
    assert.deepEqual(on("2026-11-27"), [thanksgivingWeek.id]);
    assert.deepEqual(on("2026-11-12"), []);
  });
});

describe("leave that costs a day of the month", () => {
  const november = {
    first: "2026-11-01",
    last: "2026-11-30",
    workingDays: [1, 2, 3, 4, 5],
    holidays: [{ date: "2026-11-26", name: "Thanksgiving" }],
  };
  const october = { ...november, first: "2026-10-01", last: "2026-10-31" };
  const ids = (entries: CalendarEntry[]) => entries.map((e) => e.id);

  test("a Thursday-to-Sunday request belongs to the month of its weekdays, not the month of its weekend", () => {
    // Thu Oct 29 to Sun Nov 1: November holds only the Sunday.
    const thursdayToSunday = entry("2026-10-29", "2026-11-01");
    assert.deepEqual(ids(entriesCostingDaysIn([thursdayToSunday], november)), []);
    assert.deepEqual(ids(entriesCostingDaysIn([thursdayToSunday], october)), [thursdayToSunday.id]);
    // The grid agrees: nothing on any November day.
    const days = buildMonthGrid({ ...november, month: "2026-11", today: "2026-11-01", entries: [thursdayToSunday] }).flat();
    assert.deepEqual(days.filter((d) => d.inMonth && d.entries.length > 0), []);
  });

  test("one working day inside the month is enough; a holiday or a weekend alone is not", () => {
    const intoMonday = entry("2026-10-31", "2026-11-02");
    const holidayOnly = entry("2026-11-26");
    const holidayAndFriday = entry("2026-11-26", "2026-11-27");
    const weekendOnly = entry("2026-11-07", "2026-11-08");
    const pending = entry("2026-11-03", "2026-11-03", { status: "pending" });
    const rejected = entry("2026-11-04", "2026-11-04", { status: "rejected" });
    assert.deepEqual(
      ids(entriesCostingDaysIn([intoMonday, holidayOnly, holidayAndFriday, weekendOnly, pending, rejected], november)),
      [intoMonday.id, holidayAndFriday.id, pending.id],
    );
    assert.deepEqual(
      ids(entriesCostingDaysIn([weekendOnly], { ...november, workingDays: [1, 2, 3, 4, 5, 6] })),
      [weekendOnly.id],
      "a Saturday counts where Saturday is a working day",
    );
  });

  test("the agenda leaves out leave that only touches the month on days off", () => {
    const thursdayToSunday = entry("2026-10-29", "2026-11-01");
    const items = buildAgenda({ month: "2026-11", workingDays: [1, 2, 3, 4, 5], holidays: [], entries: [thursdayToSunday] });
    assert.deepEqual(items, []);
    const octoberItems = buildAgenda({ month: "2026-10", workingDays: [1, 2, 3, 4, 5], holidays: [], entries: [thursdayToSunday] });
    assert.deepEqual(octoberItems.map((i) => i.kind === "leave" && i.entry.id), [thursdayToSunday.id]);
  });
});

describe("who's out", () => {
  function team(userId: string, personName: string, startDate: string, overrides: Partial<TeamCalendarEntry> = {}): TeamCalendarEntry {
    return { ...entry(startDate), userId, personName, departmentName: null, ...overrides };
  }

  test("one group per person, by name regardless of case, each person's leave by date", () => {
    const groups = groupByPerson([
      team("u-zed", "zed", "2026-11-05"),
      team("u-ana", "Ana", "2026-11-20"),
      team("u-ben", "ben", "2026-11-03", { status: "pending" }),
      team("u-ana", "Ana", "2026-11-02"),
      team("u-ben", "ben", "2026-11-04", { status: "cancelled" }),
      team("u-cy", "Cy", "2026-11-09", { status: "rejected" }),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.personName, g.entries.map((e) => [e.startDate, e.status])]),
      [
        ["Ana", [["2026-11-02", "approved"], ["2026-11-20", "approved"]]],
        ["ben", [["2026-11-03", "pending"]]],
        ["zed", [["2026-11-05", "approved"]]],
      ],
    );
  });

  test("two people with the same name stay apart, in a stable order", () => {
    const groups = groupByPerson([team("u2", "Sam", "2026-11-02"), team("u1", "Sam", "2026-11-03")]);
    assert.deepEqual(groups.map((g) => g.userId), ["u1", "u2"]);
  });
});

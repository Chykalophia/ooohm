import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { isDomainError } from "@/domain/errors";
import { buildImportPlan, type ImportPlan, leaveSegments, leaveTypeCodeFor } from "@/domain/timeoff/mapping";
import type { TimeOffSnapshot } from "@/domain/timeoff/source";
import { parseTimeOffDate, parseTimeOffTimestamp, readTimeOffSqlite } from "@/server/importers/timeoff/sqlite-reader";
import { buildTimeOffFixture, FIXTURE_EXPECTED_2026, FIXTURE_QUINN_2027, type FixtureData, fixtureLeave, T, U } from "../support/timeoff-fixture";

let dir: string;
let n = 0;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ooohm-timeoff-unit-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function snapshot(mutate?: (d: FixtureData) => void): TimeOffSnapshot {
  const file = path.join(dir, `f${++n}.sqlite`);
  buildTimeOffFixture(file, mutate);
  return readTimeOffSqlite(file);
}

const OPTIONS = { currentYear: 2026, today: "2026-11-01", mergePoolTypes: true };

function plan(mutate?: (d: FixtureData) => void, options: Partial<Parameters<typeof buildImportPlan>[1]> = {}): ImportPlan {
  return buildImportPlan(snapshot(mutate), { ...OPTIONS, ...options });
}

function refusal(work: () => unknown): string {
  try {
    work();
  } catch (err) {
    assert.ok(isDomainError(err, "import_refused"), String(err));
    return err.message;
  }
  assert.fail("expected an import_refused error");
}

const email = (p: ImportPlan, key: number) => p.people.find((x) => x.key === key)?.email;

describe("TimeOff SQLite reader", () => {
  test("reads Sequelize timestamps and dates in UTC", () => {
    assert.equal(parseTimeOffTimestamp("2026-03-09 07:00:00.000 +00:00"), "2026-03-09T07:00:00.000Z");
    assert.equal(parseTimeOffTimestamp("2026-03-09 00:30:00.000 +02:00"), "2026-03-08T22:30:00.000Z");
    assert.equal(parseTimeOffTimestamp(Date.UTC(2026, 2, 9)), "2026-03-09T00:00:00.000Z");
    assert.equal(parseTimeOffDate("2026-03-09"), "2026-03-09");
    assert.equal(parseTimeOffDate("2026-03-09T00:00:00Z"), "2026-03-09");
    assert.equal(parseTimeOffDate(null), null);
    assert.equal(parseTimeOffDate("not a date"), null);
  });

  test("reads every table of the fixture", () => {
    const s = snapshot();
    assert.deepEqual(
      [s.companies.length, s.departments.length, s.users.length, s.leaveTypes.length, s.leaves.length, s.bankHolidays.length, s.adjustments.length, s.schedules.length],
      [1, 2, 14, 4, 22, 6, 11, 2],
    );
    const dave = s.leaves.find((l) => l.userId === U.dave && l.dateStart === "2026-03-02")!;
    assert.deepEqual([dave.dateEnd, dave.dayPartStart, dave.dayPartEnd, dave.status], ["2026-03-04", 3, 2, 2]);
    assert.equal(s.users.find((u) => u.id === U.gina)!.endDate, "2025-06-30");
    assert.equal(s.companies[0].carryOver, 5);
  });

  test("refuses a file that is not a TimeOff database, naming what it has", () => {
    const file = path.join(dir, "other.sqlite");
    writeFileSync(file, "");
    const message = refusal(() => readTimeOffSqlite(file));
    assert.match(message, /does not look like a TimeOff\.Management database/);
  });
});

describe("TimeOff import plan: the allowance pool", () => {
  test("several allowance types are refused unless merged, and the message names the options", () => {
    const message = refusal(() => plan(undefined, { mergePoolTypes: false }));
    assert.match(message, /"Holiday", "Training"/);
    assert.match(message, /--merge-pool-types/);
    assert.match(message, /--pool-type/);
  });

  test("merged, every allowance type becomes the pool type; the others keep their own", () => {
    const p = plan();
    assert.equal(p.poolTypeKey, "HOLIDAY");
    assert.deepEqual(
      p.leaveTypes.map((t) => [t.key, t.pool, t.countsAgainstAllowance, t.defaultAllowanceDays, t.carryoverEnabled, t.carryoverMaxDays, t.timeoffTypeIds]),
      [
        ["HOLIDAY", true, true, null, true, 5, [T.holiday, T.training]],
        ["SICK_LEAVE", false, false, null, false, null, [T.sick]],
        ["JURY_DUTY", false, true, 5, false, null, [T.jury]],
      ],
    );
    const training = p.requests.find((r) => r.personKey === U.bob && r.startDate === "2026-06-15")!;
    assert.equal(training.leaveTypeKey, "HOLIDAY");
    assert.equal(training.note, "[TimeOff: Training] Conference", "the original type stays visible");
    const holiday = p.requests.find((r) => r.personKey === U.alice && r.startDate === "2025-08-04")!;
    assert.equal(holiday.note, "Summer trip", "the pool type's own leave has no prefix");
  });

  test("--pool-type picks which type's name the pool takes; an unknown one is refused", () => {
    assert.equal(plan(undefined, { poolTypeName: "training" }).leaveTypes.find((t) => t.pool)!.name, "Training");
    assert.match(refusal(() => plan(undefined, { poolTypeName: "Sick Leave" })), /not a TimeOff leave type that uses the allowance/);
  });

  test("allowance rows carry the department allowance, the adjustment plus pro-rating, and the carry", () => {
    const p = plan();
    const row = (key: number, year: number) => p.allowances.find((a) => a.personKey === key && a.year === year);
    assert.deepEqual(
      [row(U.carol, 2025), row(U.carol, 2026)].map((a) => [a?.days, a?.adjustmentDays, a?.carriedOverDays]),
      [
        [25, -15, 0],
        [25, 2, 3],
      ],
    );
    assert.deepEqual([row(U.ivan, 2026)?.days, row(U.ivan, 2026)?.adjustmentDays, row(U.ivan, 2026)?.employmentAdjustment], [20, -3, -3]);
    assert.deepEqual([row(U.gina, 2025)?.adjustmentDays, row(U.gina, 2026)], [-10, undefined], "nothing after the end date");
    assert.deepEqual([row(U.nina, 2026)?.days, row(U.nina, 2026)?.carriedOverDays], [20, 5], "a current employee who never signed in to TimeOff");
    assert.equal(p.allowances.some((a) => a.personKey === U.gina && a.year === 2026), false, "someone who left gets no current-year row");
  });

  test("a future hire gets a zero row for each year before the start and a pro-rated start-year row", () => {
    const p = plan();
    const rows = p.allowances.filter((a) => a.personKey === U.quinn).map((a) => [a.year, a.days, a.adjustmentDays, a.carriedOverDays]);
    assert.deepEqual(rows, [
      [2026, 20, -20, 0],
      [2027, 20, 0, 0],
    ]);
    const expected = p.expected.filter((e) => e.personKey === U.quinn).map((e) => [e.year, e.timeoff.remaining]);
    assert.deepEqual(expected, [
      [2026, 0],
      [2027, FIXTURE_QUINN_2027],
    ]);
    assert.equal(p.people.find((x) => x.key === U.quinn)!.createdAt, "2026-11-01T12:00:00.000Z", "joins (for the rollover) this year, not when TimeOff created the account");
  });

  test("the pool type defaults to the department allowance only when every department has the same", () => {
    const mixed = plan();
    assert.equal(mixed.leaveTypes.find((t) => t.pool)!.defaultAllowanceDays, null);
    const warning = mixed.warnings.find((w) => w.code === "pool_type_no_default");
    assert.ok(warning, "the CLI prints why new hires are not tracked");
    assert.match(warning.message, /20, 25 days/);

    const uniform = plan((d) => void (d.departments[1].allowance = 25));
    assert.equal(uniform.leaveTypes.find((t) => t.pool)!.defaultAllowanceDays, 25);
    assert.equal(uniform.warnings.some((w) => w.code === "pool_type_no_default"), false);
    // With a default, last year gets an explicit row, so the rollover never reads the default in its place.
    assert.ok(uniform.allowances.some((a) => a.personKey === U.dave && a.year === 2025));
    assert.equal(uniform.allowances.some((a) => a.personKey === U.ivan && a.year === 2025), false, "not before their start");
  });

  test("the pool type comes first even when TimeOff sorts another type before it", () => {
    const p = plan((d) => void (d.leaveTypes.find((t) => t.id === T.sick)!.sort_order = -1));
    assert.deepEqual(
      p.leaveTypes.map((t) => [t.key, t.sortOrder]),
      [
        ["HOLIDAY", 0],
        ["SICK_LEAVE", 1],
        ["JURY_DUTY", 2],
      ],
    );
  });

  test("a holiday the target company already has is counted on OOOhm's side and reported", () => {
    const p = plan(undefined, { existingHolidays: new Set(["2026-03-10"]) });
    const alice = p.requests.find((r) => r.personKey === U.alice && r.startDate === "2026-03-09")!;
    assert.equal(alice.days, 4, "OOOhm's company calendar after the import");
    assert.deepEqual(
      p.leaveCostDifferences.map((x) => [x.personKey, x.year, x.timeoff, x.ooohm, x.reason]),
      [[U.alice, 2026, 5, 4, "company_holiday"]],
    );
    assert.equal(p.expected.find((e) => e.personKey === U.alice && e.year === 2026)!.timeoff.remaining, FIXTURE_EXPECTED_2026["alice@example.com"], "TimeOff's side keeps TimeOff's holidays");
  });

  test("TimeOff's 2026 balance for each person matches the hand-worked figures", () => {
    const p = plan();
    const actual = Object.fromEntries(p.expected.filter((e) => e.year === 2026).map((e) => [email(p, e.personKey), e.timeoff.remaining]));
    assert.deepEqual(actual, FIXTURE_EXPECTED_2026);
    assert.deepEqual(p.leaveCostDifferences, [], "OOOhm counts every fixture leave as TimeOff does");
  });

  test("a leave OOOhm counts differently is reported with the reason", () => {
    const p = plan((d) => void fixtureLeave(d, { userId: U.dave, leaveTypeId: T.holiday, start: "2025-12-31", end: "2026-01-02", status: 2, dayPartStart: 3 }));
    assert.deepEqual(
      p.leaveCostDifferences.map((x) => [x.personKey, x.year, x.timeoff, x.ooohm, x.reason]),
      [[U.dave, 2026, 0.5, 1, "half_day_rule"]],
    );
  });

  test("without any allowance type there is no pool and no allowance", () => {
    const p = plan((d) => d.leaveTypes.forEach((t) => (t.use_allowance = 0)));
    assert.equal(p.poolTypeKey, null);
    assert.deepEqual([p.allowances.length, p.expected.length], [0, 0]);
    assert.ok(p.warnings.some((w) => w.code === "no_pool"));
  });
});

describe("TimeOff import plan: people", () => {
  test("emails are lowercased and deduplicated; the active account is kept and the other reported", () => {
    const p = plan();
    assert.equal(p.people.filter((x) => x.email === "henry@example.com").length, 1);
    assert.equal(p.people.find((x) => x.email === "henry@example.com")!.key, U.henry);
    assert.deepEqual(p.conflicts.map((c) => [c.code, c.timeoffId]), [["duplicate_email", U.henryDuplicate]]);
    assert.equal(p.requests.some((r) => r.personKey === U.henryDuplicate), false, "the dropped account's leave is not imported");
    assert.equal(p.skipped.users, 1);
  });

  test("roles, managers and the active flag follow TimeOff", () => {
    const p = plan();
    const of = (key: number) => p.people.find((x) => x.key === key)!;
    assert.deepEqual([of(U.alice).role, of(U.alice).canSelfApprove], ["admin", true]);
    assert.deepEqual([of(U.bob).role, of(U.olivia).role, of(U.carol).role], ["manager", "manager", "employee"]);
    assert.deepEqual([of(U.carol).managerKey, of(U.erin).managerKey], [U.bob, U.olivia], "the department boss manages its members");
    assert.deepEqual([of(U.bob).managerKey, of(U.olivia).managerKey], [null, null], "a boss is not their own manager");
    assert.deepEqual([of(U.gina).isActive, of(U.nina).isActive, of(U.henry).isActive, of(U.quinn).isActive], [false, true, true, true]);
    assert.deepEqual(
      p.warnings.filter((w) => w.code === "never_signed_in").map((w) => w.email),
      ["nina@example.com", "quinn@example.com"],
      "TimeOff's activated flag only means they never signed in",
    );
    assert.equal(of(U.ivan).createdAt, "2026-03-01T12:00:00.000Z", "joined on their start date");
  });

  test("employment follows TimeOff's end date: still employed only while it is after today", () => {
    const ending = (date: string) =>
      plan((d) => {
        const dave = d.users.find((u) => u.id === U.dave)!;
        dave.end_date = `${date} 00:00:00.000 +00:00`;
        dave.activated = 0;
      }).people.find((x) => x.key === U.dave)!.isActive;
    assert.deepEqual([ending("2026-11-02"), ending("2026-11-01"), ending("2026-10-31")], [true, false, false]);
  });

  test("a reporting loop through departments is broken, and reported", () => {
    const p = plan((d) => {
      d.users.find((u) => u.id === U.bob)!.DepartmentId = 2;
      d.users.find((u) => u.id === U.olivia)!.DepartmentId = 1;
    });
    const managerOf = (key: number) => p.people.find((x) => x.key === key)!.managerKey;
    assert.deepEqual([managerOf(U.bob), managerOf(U.olivia)].filter((m) => m === null).length, 1);
    assert.ok(p.warnings.some((w) => w.code === "manager_cycle"));
  });

  test("a personal schedule is a warning", () => {
    const p = plan();
    assert.deepEqual(p.warnings.filter((w) => w.code === "personal_schedule").map((w) => w.email), ["paula@example.com"]);
  });
});

describe("TimeOff import plan: leave", () => {
  test("statuses map to OOOhm's; a pended revoke stays approved and is reported", () => {
    const p = plan();
    const status = (key: number, start: string) => p.requests.find((r) => r.personKey === key && r.startDate === start)?.status;
    assert.deepEqual(
      [status(U.olivia, "2026-11-23"), status(U.alice, "2026-03-09"), status(U.olivia, "2026-02-02"), status(U.frank, "2026-08-10"), status(U.dave, "2026-07-06")],
      ["pending", "approved", "rejected", "approved", "cancelled"],
    );
    assert.ok(p.warnings.some((w) => w.code === "pended_revoke"));
    assert.equal(p.requests.find((r) => r.personKey === U.olivia && r.startDate === "2026-02-02")!.decisionNote, "Launch week");
  });

  test("half-day ends become separate single-day requests; a leave over New Year keeps its split", () => {
    const p = plan();
    const dave = p.requests.filter((r) => r.timeoffLeaveId === p.requests.find((x) => x.startDate === "2026-03-02")!.timeoffLeaveId);
    assert.deepEqual(
      dave.map((r) => [r.startDate, r.endDate, r.dayPortion, r.days, `${r.part}/${r.parts}`]),
      [
        ["2026-03-02", "2026-03-02", "pm", 0.5, "1/3"],
        ["2026-03-03", "2026-03-03", "full", 1, "2/3"],
        ["2026-03-04", "2026-03-04", "am", 0.5, "3/3"],
      ],
    );
    const erin = p.requests.find((r) => r.personKey === U.erin)!;
    assert.deepEqual(erin.split, [
      { year: 2025, days: 3 },
      { year: 2026, days: 2 },
    ]);
  });

  test("a leave on non-working days only is skipped", () => {
    const p = plan((d) => void fixtureLeave(d, { userId: U.erin, leaveTypeId: T.holiday, start: "2026-02-14", end: "2026-02-15", status: 2 }));
    assert.ok(p.warnings.some((w) => w.code === "leave_zero_days"));
    assert.equal(p.requests.some((r) => r.startDate === "2026-02-14"), false);
  });

  test("bank holidays become company holidays; colours that are not hex get a default", () => {
    const p = plan();
    assert.deepEqual(p.holidays.map((h) => h.date), ["2025-07-04", "2025-12-25", "2026-01-01", "2026-05-25", "2026-07-03", "2026-12-25"]);
    assert.match(p.leaveTypes.find((t) => t.key === "SICK_LEAVE")!.color, /^#[0-9a-f]{6}$/);
    assert.ok(p.warnings.some((w) => w.code === "type_color"));
  });
});

describe("TimeOff import plan: companies", () => {
  test("a file with several companies needs --timeoff-company", () => {
    const twoCompanies = (d: FixtureData) => void d.companies.push({ ...d.companies[0], id: 2, name: "Other" });
    assert.match(refusal(() => plan(twoCompanies)), /--timeoff-company/);
    assert.equal(plan(twoCompanies, { timeoffCompanyId: 1 }).company.name, "Chykalophia Test");
    assert.equal(plan(twoCompanies, { timeoffCompanyId: 2 }).people.length, 0);
  });

  test("the company schedule becomes the working days, and the carry-over setting the pool's carryover", () => {
    const p = plan((d) => {
      d.schedules[0].saturday = 1;
      d.companies[0].carry_over = 1000;
    });
    assert.deepEqual(p.company.workingDays, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual([p.company.carryoverEnabled, p.company.carryoverMaxDays], [true, null], "TimeOff's 'all days' is no cap");
    const off = plan((d) => void (d.companies[0].carry_over = 0));
    assert.deepEqual([off.company.carryoverEnabled, off.leaveTypes.find((t) => t.pool)!.carryoverEnabled], [false, false]);
  });
});

describe("leave type codes and segments", () => {
  test("codes are uppercase, at most 12 characters, unique", () => {
    assert.equal(leaveTypeCodeFor("Holiday", new Set()), "HOLIDAY");
    assert.equal(leaveTypeCodeFor("Paid time off (PTO)", new Set()), "PAID_TIME_OF");
    assert.equal(leaveTypeCodeFor("Holiday", new Set(["HOLIDAY"])), "HOLIDAY_2");
    assert.equal(leaveTypeCodeFor("Very long leave name", new Set(["VERY_LONG_LE"])), "VERY_LONG_2");
    assert.equal(leaveTypeCodeFor("¡!", new Set()), "TYPE");
  });

  test("a range longer than one OOOhm request is cut into consecutive pieces", () => {
    const parts = leaveSegments({ dateStart: "2025-01-01", dateEnd: "2026-06-30", dayPartStart: 1, dayPartEnd: 1 });
    assert.deepEqual(
      parts.map((r) => [r.startDate, r.endDate]),
      [
        ["2025-01-01", "2026-01-01"],
        ["2026-01-02", "2026-06-30"],
      ],
    );
  });
});

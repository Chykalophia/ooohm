import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isDomainError } from "@/domain/errors";
import { allowanceRow, allowanceYears, balanceYears, planAllowances } from "@/modules/import/domain/timeoff/plan/allowances";
import { planCalendars } from "@/modules/import/domain/timeoff/plan/calendars";
import { companyScope, planCompany } from "@/modules/import/domain/timeoff/plan/company";
import { planDepartments } from "@/modules/import/domain/timeoff/plan/departments";
import { planHolidays } from "@/modules/import/domain/timeoff/plan/holidays";
import { planLeaveTypes } from "@/modules/import/domain/timeoff/plan/leave-types";
import { planPeople } from "@/modules/import/domain/timeoff/plan/people";
import { leaveParts, planRequests, type RequestContext } from "@/modules/import/domain/timeoff/plan/requests";
import type { ImportIssue, PlannedCompany } from "@/modules/import/domain/timeoff/plan/types";
import { timeOffYearBalance } from "@/modules/import/domain/timeoff/balance";
import type {
  TimeOffCompany,
  TimeOffDepartment,
  TimeOffLeave,
  TimeOffLeaveType,
  TimeOffSnapshot,
  TimeOffUser,
} from "@/modules/import/domain/timeoff/source";

/** Each planning step on hand-made TimeOff records: what it maps, and what it warns about. */

const company = (over: Partial<TimeOffCompany> = {}): TimeOffCompany => ({
  id: 1,
  name: "Acme",
  country: null,
  timezone: "Europe/London",
  startOfNewYear: 1,
  carryOver: 0,
  ...over,
});
const department = (id: number, over: Partial<TimeOffDepartment> = {}): TimeOffDepartment => ({
  id,
  companyId: 1,
  name: `Dept ${id}`,
  allowance: 25,
  bossId: null,
  includePublicHolidays: true,
  isAccruedAllowance: false,
  ...over,
});
const user = (id: number, over: Partial<TimeOffUser> = {}): TimeOffUser => ({
  id,
  companyId: 1,
  departmentId: 10,
  email: `u${id}@example.com`,
  name: `User`,
  lastname: `${id}`,
  admin: false,
  activated: true,
  autoApprove: false,
  startDate: "2020-01-01",
  endDate: null,
  createdAt: "2020-01-01T00:00:00.000Z",
  ...over,
});
const leaveType = (id: number, over: Partial<TimeOffLeaveType> = {}): TimeOffLeaveType => ({
  id,
  companyId: 1,
  name: `Type ${id}`,
  color: "#123456",
  useAllowance: false,
  limit: 0,
  sortOrder: id,
  autoApprove: false,
  ...over,
});
const leave = (id: number, over: Partial<TimeOffLeave> = {}): TimeOffLeave => ({
  id,
  userId: 100,
  approverId: null,
  leaveTypeId: 1,
  status: 2,
  dateStart: "2026-03-02",
  dateEnd: "2026-03-02",
  dayPartStart: 1,
  dayPartEnd: 1,
  employeeComment: null,
  approverComment: null,
  createdAt: "2026-02-01T00:00:00.000Z",
  decidedAt: "2026-02-02T00:00:00.000Z",
  ...over,
});
const snapshot = (over: Partial<TimeOffSnapshot> = {}): TimeOffSnapshot => ({
  companies: [company()],
  departments: [department(10)],
  users: [user(100)],
  leaveTypes: [leaveType(1, { name: "Holiday", useAllowance: true })],
  leaves: [],
  bankHolidays: [],
  adjustments: [],
  schedules: [],
  departmentSupervisorLinks: 0,
  ...over,
});
const collect = () => {
  const issues: ImportIssue[] = [];
  return { issues, warn: (i: ImportIssue) => issues.push(i), codes: () => issues.map((i) => i.code) };
};
const MON_FRI = [1, 2, 3, 4, 5];
const plannedCompany: PlannedCompany = { timeoffId: 1, name: "Acme", timezone: "Europe/London", workingDays: MON_FRI, carryoverEnabled: true, carryoverMaxDays: 5 };

describe("planning step: company", () => {
  test("takes TimeOff's schedule and carry-over; an empty schedule is Monday to Friday, a huge carry-over no cap", () => {
    const w = collect();
    const s = snapshot({ schedules: [{ companyId: 1, userId: null, days: [1, 1, 1, 1, 2, 2, 2] }] });
    assert.deepEqual(planCompany(s, company({ carryOver: 5 }), w.warn), { timeoffId: 1, name: "Acme", timezone: "Europe/London", workingDays: [1, 2, 3, 4], carryoverEnabled: true, carryoverMaxDays: 5 });
    const empty = snapshot({ schedules: [{ companyId: 1, userId: null, days: [2, 2, 2, 2, 2, 2, 2] }] });
    const planned = planCompany(empty, company({ carryOver: 100_000, timezone: "Mars/Olympus", startOfNewYear: 4 }), w.warn);
    assert.deepEqual([planned.workingDays, planned.timezone, planned.carryoverMaxDays], [MON_FRI, null, null]);
    assert.deepEqual(w.codes(), ["company_schedule_empty", "timezone_unknown", "start_of_year"]);
  });

  test("the scope holds only the company's records, types by sort order", () => {
    const s = snapshot({
      users: [user(100), user(200, { companyId: 2 })],
      leaveTypes: [leaveType(2, { sortOrder: 5 }), leaveType(1, { sortOrder: 1 }), leaveType(3, { companyId: 2 })],
      leaves: [leave(1), leave(2), leave(3, { userId: 200 })],
    });
    const scope = companyScope(s, s.companies[0]);
    assert.deepEqual([scope.users.map((u) => u.id), scope.leaveTypes.map((t) => t.id), scope.leaves.map((l) => l.id)], [[100], [1, 2], [1, 2]]);
    assert.equal(scope.leaveCount.get(100), 2);
  });
});

describe("planning step: holidays", () => {
  test("one per date by date, invalid dates skipped, and the company's own holidays join OOOhm's calendar", () => {
    const w = collect();
    const s = snapshot({
      bankHolidays: [
        { id: 2, companyId: 1, name: "Boxing Day", date: "2026-12-26" },
        { id: 1, companyId: 1, name: "  ", date: "2026-12-25" },
        { id: 3, companyId: 1, name: "Again", date: "2026-12-25" },
        { id: 4, companyId: 1, name: "Bad", date: "2026-02-30" },
        { id: 5, companyId: 2, name: "Elsewhere", date: "2026-01-01" },
      ],
    });
    const plan = planHolidays(s, 1, new Set(["2026-05-01"]), w.warn);
    assert.deepEqual(plan.holidays, [
      { date: "2026-12-25", name: "Holiday", timeoffId: 1 },
      { date: "2026-12-26", name: "Boxing Day", timeoffId: 2 },
    ]);
    assert.deepEqual([...plan.ooohmHolidays].sort(), ["2026-05-01", "2026-12-25", "2026-12-26"]);
    assert.deepEqual(plan.extraHolidays, ["2026-05-01"]);
    assert.deepEqual(w.codes().sort(), ["holiday_duplicate", "holiday_invalid"]);
  });
});

describe("planning step: departments", () => {
  test("two departments with one name become one; what OOOhm drops is a warning", () => {
    const w = collect();
    const s = snapshot({
      departments: [department(10, { name: "Ops" }), department(11, { name: "ops", includePublicHolidays: false }), department(12, { name: "Sales", isAccruedAllowance: true })],
      departmentSupervisorLinks: 2,
    });
    const plan = planDepartments(s, 1, w.warn);
    assert.deepEqual(plan.departments, [{ key: 10, name: "Ops" }, { key: 12, name: "Sales" }]);
    assert.deepEqual([...plan.departmentKey], [[10, 10], [11, 10], [12, 12]]);
    assert.deepEqual(w.codes(), ["department_duplicate", "department_hides_holidays", "accrued_allowance", "department_supervisors"]);
  });
});

describe("planning step: people", () => {
  test("one person per email (the active one), bosses become managers, a loop is broken", () => {
    const w = collect();
    const conflicts: ImportIssue[] = [];
    const s = snapshot({
      departments: [department(10, { bossId: 101 }), department(11, { bossId: 100 })],
      users: [
        user(100, { departmentId: 10, admin: true }),
        user(101, { departmentId: 11 }),
        user(102, { email: "U100@example.com", endDate: "2020-06-30" }),
        user(103, { email: "not an email" }),
        user(104, { departmentId: 10, activated: false, startDate: "2027-03-01" }),
      ],
    });
    const scope = companyScope(s, s.companies[0]);
    const plan = planPeople(scope, planDepartments(s, 1, () => {}), "2026-11-01", w.warn, conflicts);
    assert.deepEqual(conflicts.map((c) => [c.code, c.timeoffId]), [["invalid_email", 103], ["duplicate_email", 102]]);
    assert.equal(plan.skippedUsers, 2);
    assert.deepEqual(
      plan.people.map((p) => [p.key, p.email, p.role, p.managerKey, p.isActive]),
      [
        [100, "u100@example.com", "admin", null, true],
        [101, "u101@example.com", "manager", 100, true],
        [104, "u104@example.com", "employee", 101, true],
      ],
    );
    assert.equal(plan.personOf.get(102), 100);
    assert.equal(plan.people[2].createdAt, "2026-11-01T12:00:00.000Z");
    assert.equal(plan.people[0].createdAt, "2020-01-01T12:00:00.000Z");
    assert.deepEqual(w.codes(), ["manager_cycle", "never_signed_in"]);
  });
});

describe("planning step: leave types", () => {
  const options = { mergePoolTypes: true };
  test("the pool type leads and takes every pool type's leave; a capped type is tracked at its limit", () => {
    const w = collect();
    const types = [
      leaveType(1, { name: "Sick", limit: 10, sortOrder: 1 }),
      leaveType(2, { name: "Holiday", useAllowance: true, sortOrder: 2 }),
      leaveType(3, { name: "Training", useAllowance: true, sortOrder: 3, color: "bg-red" }),
    ];
    const plan = planLeaveTypes(types, [department(10)], plannedCompany, options, w.warn);
    assert.deepEqual(
      plan.leaveTypes.map((t) => [t.key, t.pool, t.countsAgainstAllowance, t.defaultAllowanceDays, t.carryoverMaxDays, t.sortOrder, t.timeoffTypeIds]),
      [
        ["HOLIDAY", true, true, 25, 5, 0, [2, 3]],
        ["SICK", false, true, 10, null, 1, [1]],
      ],
    );
    assert.deepEqual([...plan.typeKeyOf], [[2, "HOLIDAY"], [3, "HOLIDAY"], [1, "SICK"]]);
    assert.equal(plan.poolKey, "HOLIDAY");
    assert.deepEqual(w.codes(), []);
  });

  test("departments with different allowances give the pool no default; no pool type is a warning", () => {
    const w = collect();
    const plan = planLeaveTypes([leaveType(1, { useAllowance: true })], [department(10), department(11, { allowance: 20 })], plannedCompany, options, w.warn);
    assert.equal(plan.poolDefault, null);
    const none = planLeaveTypes([leaveType(1)], [department(10)], plannedCompany, options, w.warn);
    assert.equal(none.poolKey, null);
    assert.deepEqual(w.codes(), ["pool_type_no_default", "no_pool"]);
  });

  test("several pool types without merging are refused", () => {
    const types = [leaveType(1, { useAllowance: true }), leaveType(2, { useAllowance: true })];
    assert.throws(() => planLeaveTypes(types, [], plannedCompany, {}, () => {}), (err) => isDomainError(err, "import_refused"));
  });
});

describe("planning steps: calendars, requests and allowances", () => {
  const s = snapshot({
    users: [user(100), user(101, { email: "own@example.com" })],
    schedules: [{ companyId: null, userId: 101, days: [1, 1, 1, 1, 2, 2, 2] }],
    leaveTypes: [leaveType(1, { name: "Holiday", useAllowance: true }), leaveType(2, { name: "Training", useAllowance: true })],
    adjustments: [{ userId: 100, year: 2026, adjustment: 2, carriedOverAllowance: 3 }],
    leaves: [
      // Monday afternoon to Wednesday morning: three requests.
      leave(1, { dateStart: "2026-03-02", dateEnd: "2026-03-04", dayPartStart: 3, dayPartEnd: 2, employeeComment: "Trip" }),
      leave(2, { leaveTypeId: 2, dateStart: "2026-03-09", dateEnd: "2026-03-09" }),
      leave(3, { dateStart: "2026-03-07", dateEnd: "2026-03-08" }),
      leave(4, { leaveTypeId: 99 }),
      leave(5, { userId: 999 }),
      leave(6, { status: 4, dateStart: "2026-03-10", dateEnd: "2026-03-10" }),
    ],
  });
  const scope = companyScope(s, s.companies[0]);
  const people = planPeople(scope, planDepartments(s, 1, () => {}), "2026-11-01", () => {}, []);
  const types = planLeaveTypes(scope.leaveTypes, s.departments, plannedCompany, { mergePoolTypes: true }, () => {});

  test("a schedule of one's own is a warning, and stays that person's TimeOff calendar", () => {
    const w = collect();
    const calendars = planCalendars(people.kept, s, MON_FRI, new Set(), w.warn);
    assert.deepEqual([...calendars.ownSchedule], [101]);
    assert.deepEqual([...calendars.calendarOf.get(101)!.workingDays], [1, 2, 3, 4]);
    assert.deepEqual(w.issues.map((i) => [i.code, i.email]), [["personal_schedule", "own@example.com"]]);
  });

  const calendars = planCalendars(people.kept, s, MON_FRI, new Set(), () => {});
  const context: RequestContext = {
    ...types,
    scope,
    keptIds: people.keptIds,
    personOf: people.personOf,
    calendars,
    companyCalendar: { workingDays: MON_FRI, holidays: new Set() },
    ooohmHolidays: new Set(),
    extraHolidays: [],
  };

  test("a leave with half-day ends becomes a request per part; another pool type keeps its name in the note", () => {
    const parts = leaveParts(scope.leaves[0], context.companyCalendar);
    assert.deepEqual(parts.map((p) => [p.range.startDate, p.range.dayPortion, p.days]), [["2026-03-02", "pm", 0.5], ["2026-03-03", "full", 1], ["2026-03-04", "am", 0.5]]);
    const w = collect();
    const plan = planRequests(context, w.warn);
    assert.deepEqual(
      plan.requests.map((r) => [r.timeoffLeaveId, r.part, r.parts, r.startDate, r.dayPortion, r.days, r.leaveTypeKey, r.status, r.note]),
      [
        [1, 1, 3, "2026-03-02", "pm", 0.5, "HOLIDAY", "approved", "Trip"],
        [1, 2, 3, "2026-03-03", "full", 1, "HOLIDAY", "approved", "Trip"],
        [1, 3, 3, "2026-03-04", "am", 0.5, "HOLIDAY", "approved", "Trip"],
        [2, 1, 1, "2026-03-09", "full", 1, "HOLIDAY", "approved", "[TimeOff: Training]"],
        [6, 1, 1, "2026-03-10", "full", 1, "HOLIDAY", "approved", null],
      ],
    );
    // Leave 3 is a weekend and 4 has an unknown type; 5 is another company's, outside the scope.
    assert.equal(plan.skippedLeaves, 2);
    assert.deepEqual(w.codes(), ["leave_invalid", "leave_zero_days", "pended_revoke"]);
    assert.deepEqual([...plan.poolLeavesOf.keys()], [100]);
  });

  test("allowance rows carry the pool for every year from the first to the current one, with TimeOff's balance", () => {
    const leave = planRequests(context, () => {});
    const c = {
      options: { currentYear: 2026 },
      poolKey: "HOLIDAY",
      poolDefault: 25,
      people: people.people,
      departmentById: new Map(s.departments.map((d) => [d.id, d])),
      poolLeavesOf: leave.poolLeavesOf,
      calendarOf: calendars.calendarOf,
      adjustments: s.adjustments,
      adjustmentOf: new Map(s.adjustments.map((a) => [`${a.userId}|${a.year}`, a])),
    };
    const plan = planAllowances(people.kept, c, () => {});
    assert.deepEqual(
      plan.allowances.filter((a) => a.personKey === 100).map((a) => [a.year, a.days, a.adjustmentDays, a.carriedOverDays]),
      [
        [2025, 25, 0, 0],
        [2026, 25, 2, 3],
      ],
    );
    const used2026 = plan.expected.find((e) => e.personKey === 100 && e.year === 2026)!.timeoff;
    assert.deepEqual([used2026.total, used2026.used, used2026.remaining], [30, 4, 26]);
  });

  test("a future hire gets zero rows up to their start year; years outside employment get none", () => {
    const hire = user(300, { startDate: "2027-03-01" });
    const c = { options: { currentYear: 2026 }, poolDefault: 25, adjustments: [] } as unknown as Parameters<typeof balanceYears>[3];
    const years = balanceYears(hire, true, [], c);
    assert.deepEqual([...years].sort(), [2026, 2027]);
    assert.deepEqual([...allowanceYears(hire, years, 2026)], [2026, 2027]);
    assert.deepEqual([...allowanceYears(user(301, { endDate: "2025-05-01" }), new Set([2024, 2026]), 2026)], [2024, 2025]);
    const before = timeOffYearBalance({ year: 2026, nominal: 25, startDate: "2027-03-01", endDate: null, adjustment: 0, carriedOver: 0, used: 0 });
    assert.deepEqual(allowanceRow({ user: hire, email: "h@example.com" }, 2026, 25, before, "HOLIDAY"), {
      personKey: 300,
      leaveTypeKey: "HOLIDAY",
      year: 2026,
      days: 25,
      adjustmentDays: -25,
      carriedOverDays: 0,
      timeoffAdjustment: 0,
      employmentAdjustment: -25,
    });
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor } from "@/domain/actor";
import { formatWait } from "@/lib/format";
import { byUser } from "@/domain/change-source";
import {
  allocateYearToMonths,
  buildLeaveReport,
  canSeeReportBalances,
  canViewReports,
  type LeaveReportInput,
  REPORT_TREND_YEARS,
  type ReportRequest,
  reportCsv,
  reportScopeFor,
  splitLeaveDaysByMonth,
} from "@/domain/reports";

const MON_FRI = [1, 2, 3, 4, 5];
const calendar = { workingDays: MON_FRI, holidays: ["2026-11-26"] };

const actor = (role: Actor["role"], id = "me"): Actor => ({ id, companyId: "co", role, canSelfApprove: false, source: byUser(id) });

describe("who may see reports", () => {
  test("admins and managers, never employees", () => {
    assert.equal(canViewReports(actor("admin")), true);
    assert.equal(canViewReports(actor("manager")), true);
    assert.equal(canViewReports(actor("employee")), false);
  });

  test("admins see the whole company, managers their direct reports", () => {
    assert.deepEqual(reportScopeFor(actor("admin")), { kind: "company" });
    assert.deepEqual(reportScopeFor(actor("manager", "mo")), { kind: "team", managerId: "mo" });
  });

  test("balances follow the team page's rule: admins always, managers while the company allows it", () => {
    assert.equal(canSeeReportBalances(actor("admin"), false), true);
    assert.equal(canSeeReportBalances(actor("manager"), true), true);
    assert.equal(canSeeReportBalances(actor("manager"), false), false);
  });
});

describe("splitLeaveDaysByMonth", () => {
  test("counts only working days, split at month ends", () => {
    // Thu Oct 29 to Wed Nov 4: Thu, Fri in October; Mon to Wed in November.
    assert.deepEqual(splitLeaveDaysByMonth({ startDate: "2026-10-29", endDate: "2026-11-04", dayPortion: "full" }, calendar), [
      { month: "2026-10", days: 2 },
      { month: "2026-11", days: 3 },
    ]);
  });

  test("skips holidays and counts a half day as 0.5", () => {
    assert.deepEqual(splitLeaveDaysByMonth({ startDate: "2026-11-25", endDate: "2026-11-27", dayPortion: "full" }, calendar), [
      { month: "2026-11", days: 2 },
    ]);
    assert.deepEqual(splitLeaveDaysByMonth({ startDate: "2026-11-24", endDate: "2026-11-24", dayPortion: "am" }, calendar), [
      { month: "2026-11", days: 0.5 },
    ]);
  });
});

describe("allocateYearToMonths", () => {
  const range = { startDate: "2026-10-29", endDate: "2026-11-04", dayPortion: "full" } as const;

  test("uses the calendar's split when it matches what the year was charged", () => {
    assert.deepEqual(allocateYearToMonths(range, calendar, 2026, 5), [
      { month: "2026-10", days: 2 },
      { month: "2026-11", days: 3 },
    ]);
  });

  test("scales to the stored days when the calendar changed since (months still add up to the year)", () => {
    const got = allocateYearToMonths(range, calendar, 2026, 4);
    assert.equal(
      got.reduce((s, m) => s + m.days, 0),
      4,
    );
    assert.deepEqual(
      got.map((m) => m.month),
      ["2026-10", "2026-11"],
    );
  });

  test("puts stored days on the range's first month in the year when the calendar now counts none", () => {
    const weekend = { startDate: "2026-11-07", endDate: "2026-11-08", dayPortion: "full" } as const;
    assert.deepEqual(allocateYearToMonths(weekend, calendar, 2026, 2), [{ month: "2026-11", days: 2 }]);
  });

  test("only the asked year: a request over New Year gives each year its own months", () => {
    const newYear = { startDate: "2026-12-31", endDate: "2027-01-04", dayPortion: "full" } as const;
    assert.deepEqual(allocateYearToMonths(newYear, calendar, 2027, 2), [{ month: "2027-01", days: 2 }]);
    assert.deepEqual(allocateYearToMonths(newYear, calendar, 2026, 1), [{ month: "2026-12", days: 1 }]);
  });

  test("nothing stored, nothing allocated", () => {
    assert.deepEqual(allocateYearToMonths(range, calendar, 2026, 0), []);
  });
});

const PTO = { id: "pto", name: "PTO", color: "#0f766e" };
const SICK = { id: "sick", name: "Sick", color: "#b45309" };

let seq = 0;
function request(userId: string, startDate: string, endDate: string, extra: Partial<ReportRequest> = {}): ReportRequest {
  const dayPortion = extra.dayPortion ?? "full";
  const split = extra.split ?? [{ year: Number(startDate.slice(0, 4)), days: splitLeaveDaysByMonth({ startDate, endDate, dayPortion }, calendar).reduce((s, m) => s + m.days, 0) }];
  return {
    id: `r${++seq}`,
    userId,
    leaveTypeId: "pto",
    status: "approved",
    startDate,
    endDate,
    dayPortion,
    approverId: "mo",
    createdAt: new Date(`${startDate}T09:00:00Z`),
    decidedAt: new Date(`${startDate}T13:00:00Z`),
    ...extra,
    split,
  };
}

function input(extra: Partial<LeaveReportInput> = {}): LeaveReportInput {
  return {
    year: 2026,
    today: "2026-11-01",
    workingDays: MON_FRI,
    holidays: ["2026-11-26"],
    leaveTypes: [PTO, SICK],
    departments: [
      { id: "dev", name: "Dev" },
      { id: "ops", name: "Ops" },
    ],
    people: [
      { id: "ana", name: "Ana", departmentId: "dev", isActive: true },
      { id: "bo", name: "Bo", departmentId: "dev", isActive: true },
      { id: "cy", name: "Cy", departmentId: "ops", isActive: true },
      { id: "di", name: "Di", departmentId: null, isActive: true },
      { id: "gone", name: "Gone", departmentId: "ops", isActive: false },
    ],
    requests: [],
    remaining: null,
    ...extra,
  };
}

describe("buildLeaveReport", () => {
  test("an empty year: zeros everywhere, twelve months, a trend of REPORT_TREND_YEARS years", () => {
    const report = buildLeaveReport(input());
    assert.equal(report.totals.approvedDays, 0);
    assert.equal(report.totals.pendingDays, 0);
    assert.equal(report.totals.headcount, 4);
    assert.equal(report.totals.daysPerPerson, 0);
    assert.equal(report.totals.medianDecisionHours, null);
    assert.equal(report.months.length, 12);
    assert.deepEqual(
      report.trend.map((y) => y.year),
      [2022, 2023, 2024, 2025, 2026],
    );
    assert.equal(report.trend.length, REPORT_TREND_YEARS);
    assert.deepEqual(report.byType, []);
    assert.deepEqual(
      report.people.map((p) => p.name),
      ["Ana", "Bo", "Cy", "Di"],
    );
  });

  test("totals count approved and pending days of the year from each request's stored split", () => {
    const report = buildLeaveReport(
      input({
        requests: [
          request("ana", "2026-03-02", "2026-03-06"), // 5 approved
          request("bo", "2026-11-24", "2026-11-24", { dayPortion: "am" }), // 0.5 approved
          request("cy", "2026-12-07", "2026-12-08", { status: "pending", decidedAt: null }), // 2 pending
          request("cy", "2026-05-04", "2026-05-04", { status: "rejected" }),
          request("di", "2026-06-01", "2026-06-01", { status: "cancelled", decidedAt: null }),
          // Over New Year from 2025: only its 2026 day counts here.
          request("ana", "2025-12-31", "2026-01-02", {
            split: [
              { year: 2025, days: 1 },
              { year: 2026, days: 2 },
            ],
          }),
        ],
      }),
    );
    assert.equal(report.totals.approvedDays, 7.5);
    assert.equal(report.totals.pendingDays, 2);
    assert.deepEqual(report.totals.requests, { approved: 3, pending: 1, rejected: 1, cancelled: 1 });
    assert.equal(report.totals.peopleOff, 2);
    // 7.5 days over 4 active people.
    assert.equal(report.totals.daysPerPerson, 1.9);
  });

  test("months hold approved days by leave type, and months after today's are marked as booked ahead", () => {
    const report = buildLeaveReport(
      input({
        requests: [
          request("ana", "2026-10-29", "2026-11-04"), // Oct 2, Nov 3
          request("bo", "2026-10-05", "2026-10-05", { leaveTypeId: "sick" }),
          request("cy", "2026-12-07", "2026-12-08"),
          request("di", "2026-12-09", "2026-12-09", { status: "pending", decidedAt: null }),
        ],
      }),
    );
    const oct = report.months[9];
    assert.equal(oct.month, "2026-10");
    assert.equal(oct.total, 3);
    assert.deepEqual(oct.byType, [
      { leaveTypeId: "pto", days: 2 },
      { leaveTypeId: "sick", days: 1 },
    ]);
    assert.equal(oct.ahead, false);
    assert.equal(report.months[10].total, 3);
    assert.equal(report.months[10].ahead, false, "today's month is not ahead");
    assert.equal(report.months[11].total, 2, "pending leave stays out of the months");
    assert.equal(report.months[11].ahead, true);
  });

  test("the previous year's months, for comparison, and the trend by year", () => {
    const report = buildLeaveReport(
      input({
        requests: [
          request("ana", "2025-02-02", "2025-02-06"), // Mon..Fri? Feb 2 2025 is a Sunday: 4 days
          request("ana", "2023-07-03", "2023-07-04"),
          request("ana", "2026-02-02", "2026-02-02"),
        ],
      }),
    );
    assert.equal(report.previousYearMonths.length, 12);
    assert.equal(report.previousYearMonths[1], 4);
    assert.deepEqual(
      report.trend.map((y) => y.days),
      [0, 2, 0, 4, 1],
    );
  });

  test("by leave type, most days first, with request counts; types with nothing are left out", () => {
    const report = buildLeaveReport(
      input({
        requests: [
          request("ana", "2026-03-02", "2026-03-03", { leaveTypeId: "sick" }),
          request("bo", "2026-03-02", "2026-03-06"),
          request("cy", "2026-04-06", "2026-04-06"),
        ],
      }),
    );
    assert.deepEqual(
      report.byType.map(({ leaveTypeId, days, requests }) => ({ leaveTypeId, days, requests })),
      [
        { leaveTypeId: "pto", days: 6, requests: 2 },
        { leaveTypeId: "sick", days: 2, requests: 1 },
      ],
    );
    assert.equal(report.byType[0].name, "PTO");
    assert.equal(report.byType[0].color, PTO.color);
  });

  test("by department: days and days per active person, people without one last", () => {
    const report = buildLeaveReport(
      input({
        requests: [
          request("ana", "2026-03-02", "2026-03-06"),
          request("bo", "2026-03-09", "2026-03-09"),
          request("cy", "2026-03-10", "2026-03-11"),
          request("gone", "2026-01-05", "2026-01-06"),
        ],
      }),
    );
    assert.deepEqual(report.byDepartment, [
      { departmentId: "dev", name: "Dev", headcount: 2, days: 6, daysPerPerson: 3 },
      { departmentId: "ops", name: "Ops", headcount: 1, days: 4, daysPerPerson: 4 },
      { departmentId: null, name: "No department", headcount: 1, days: 0, daysPerPerson: 0 },
    ]);
  });

  test("people: active ones always, inactive ones only with leave in the year; balances only when given", () => {
    const report = buildLeaveReport(
      input({
        requests: [request("gone", "2026-01-05", "2026-01-06"), request("ana", "2026-03-02", "2026-03-02", { status: "pending", decidedAt: null })],
        remaining: new Map([
          ["ana", 14],
          ["bo", null],
        ]),
      }),
    );
    assert.deepEqual(
      report.people.map((p) => [p.name, p.isActive, p.approvedDays, p.pendingDays, p.remaining]),
      [
        ["Ana", true, 0, 1, 14],
        ["Bo", true, 0, 0, null],
        ["Cy", true, 0, 0, null],
        ["Di", true, 0, 0, null],
        ["Gone", false, 2, 0, null],
      ],
    );
    assert.equal(report.showsBalances, true);
    assert.equal(buildLeaveReport(input()).showsBalances, false);
  });

  test("median decision time skips self-approved and instant decisions", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 2, 2, h));
    const report = buildLeaveReport(
      input({
        requests: [
          request("ana", "2026-03-02", "2026-03-02", { createdAt: at(0), decidedAt: at(2) }),
          request("bo", "2026-03-03", "2026-03-03", { createdAt: at(0), decidedAt: at(4), status: "rejected" }),
          request("cy", "2026-03-04", "2026-03-04", { createdAt: at(0), decidedAt: at(10) }),
          // Self-approved, and added for someone (decided as it was made): not waits.
          request("mo", "2026-03-05", "2026-03-05", { approverId: "mo", createdAt: at(0), decidedAt: at(0) }),
          request("di", "2026-03-06", "2026-03-06", { createdAt: at(1), decidedAt: at(1) }),
        ],
      }),
    );
    assert.equal(report.totals.medianDecisionHours, 4);
    assert.equal(report.totals.decisions, 3);
  });
});

describe("reportCsv", () => {
  test("one row per person with a column per leave type, and the balance column only when shown", () => {
    const withBalances = buildLeaveReport(
      input({
        requests: [request("ana", "2026-03-02", "2026-03-03", { leaveTypeId: "sick" }), request("ana", "2026-03-04", "2026-03-04")],
        remaining: new Map([["ana", 9]]),
      }),
    );
    const lines = reportCsv(withBalances).trimEnd().split("\r\n");
    assert.equal(lines[0], "Person,Department,Active,PTO,Sick,Approved days,Pending days,Days left");
    assert.equal(lines[1], "Ana,Dev,yes,1,2,3,0,9");
    assert.equal(lines.length, 5);

    const without = reportCsv(buildLeaveReport(input())).split("\r\n")[0];
    assert.equal(without, "Person,Department,Active,PTO,Sick,Approved days,Pending days");
  });
});

describe("formatWait", () => {
  test("rounds up to hours under a day, then to days", () => {
    assert.equal(formatWait(0.4), "under an hour");
    assert.equal(formatWait(1), "under an hour");
    assert.equal(formatWait(1.2), "2 hours");
    assert.equal(formatWait(23.5), "24 hours");
    assert.equal(formatWait(24), "1 day");
    assert.equal(formatWait(49), "3 days");
  });
});

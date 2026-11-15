import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { presentLeaveReport, toLeaveReportDTO } from "@/modules/reports";
import { buildLeaveReport } from "@/modules/reports/domain/leave-report";

/**
 * The Reports page reads a `LeaveReportDTO` and nothing else. These pin its fields:
 * after a deliberate change, update the snapshot with
 * `pnpm test -- --test-update-snapshots` and review the diff.
 */

const report = buildLeaveReport({
  year: 2026,
  today: "2026-03-10",
  workingDays: [1, 2, 3, 4, 5],
  holidays: [],
  leaveTypes: [{ id: "vac", name: "Vacation", color: "#0f766e" }],
  departments: [{ id: "dev", name: "Dev" }],
  people: [
    { id: "ana", name: "Ana", departmentId: "dev", isActive: true },
    { id: "bo", name: "Bo", departmentId: null, isActive: true },
  ],
  requests: [
    {
      id: "r1",
      userId: "ana",
      leaveTypeId: "vac",
      status: "approved",
      startDate: "2026-02-02",
      endDate: "2026-02-03",
      dayPortion: "full",
      approverId: "boss",
      createdAt: new Date("2026-01-20T09:00:00Z"),
      decidedAt: new Date("2026-01-20T12:00:00Z"),
      split: [{ year: 2026, days: 2 }],
    },
  ],
  remaining: new Map([
    ["ana", 23],
    ["bo", null],
  ]),
});

// Departments as the repository returns them: more than the page may see.
const stored = { id: "dev", name: "Dev", companyId: "co", managerId: "boss", createdAt: new Date("2025-01-01T00:00:00Z") };

const dto = toLeaveReportDTO({ nav: { year: 2026, current: 2026 }, departments: [stored], department: stored, scope: { kind: "company" }, report });

describe("toLeaveReportDTO", () => {
  test("keeps a department's id and name only", () => {
    assert.deepEqual(dto.departments, [{ id: "dev", name: "Dev" }]);
    assert.deepEqual(dto.department, { id: "dev", name: "Dev" });
  });

  test("returns exactly the fields the page shows", (t) => {
    assert.deepEqual(Object.keys(dto).sort(), ["department", "departments", "nav", "report", "scope"]);
    t.assert.snapshot(dto);
  });

  test("the page's view model reads from the DTO alone", (t) => {
    const view = presentLeaveReport(dto);
    t.assert.snapshot({ ...view, yearNav: { ...view.yearNav, href: view.yearNav.href(2025) } });
  });
});

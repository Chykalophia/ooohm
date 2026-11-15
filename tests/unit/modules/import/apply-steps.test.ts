import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isDomainError } from "@/shared/kernel/errors";
import { allowanceRows, requestAuditAfter, requestRows } from "@/modules/import/application/steps/apply-leave";
import { leaveTypeSettings, matchingLeaveType } from "@/modules/import/application/steps/apply-organisation";
import { newAccountRows, personAfterImport } from "@/modules/import/application/steps/apply-people";
import { completedPayload, importCounts, importReport, poolLeaveType } from "@/modules/import/application/steps/finish";
import { activeAdminsAfter, assertKeepsAnActiveAdmin, matchPeople } from "@/modules/import/application/steps/match-people";
import { mismatchReasons, reconciliationRow } from "@/modules/import/application/steps/reconcile";
import { entry, type ImportRun } from "@/modules/import/application/steps/run";
import { timeOffYearBalance } from "@/modules/import/domain/timeoff/balance";
import type { ImportPlan, PlannedLeaveType, PlannedPerson, PlannedRequest } from "@/modules/import/domain/timeoff/plan/types";
import type { ExistingAccount } from "@/modules/import/infrastructure/drizzle-import.repository";
import { at, first, take } from "../../../support/present";

/** The records each import write step maps from the plan, before anything is written. */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const person = (key: number, over: Partial<PlannedPerson> = {}): PlannedPerson => ({
  key,
  email: `p${key}@example.com`,
  name: `Person ${key}`,
  role: "employee",
  departmentKey: 10,
  managerKey: null,
  canSelfApprove: false,
  isActive: true,
  createdAt: "2020-01-01T12:00:00.000Z",
  ...over,
});
const account = (id: string, email: string, over: Partial<ExistingAccount> = {}): ExistingAccount => ({
  id,
  email,
  name: "Existing",
  companyId: COMPANY,
  role: "employee",
  departmentId: null,
  managerId: null,
  canSelfApprove: false,
  isActive: true,
  ...over,
});
const request = (over: Partial<PlannedRequest> = {}): PlannedRequest => ({
  personKey: 1,
  leaveTypeKey: "HOLIDAY",
  timeoffLeaveId: 500,
  part: 1,
  parts: 1,
  startDate: "2026-03-02",
  endDate: "2026-03-02",
  dayPortion: "full",
  days: 1,
  split: [{ year: 2026, days: 1 }],
  status: "approved",
  approverKey: 2,
  note: null,
  decisionNote: null,
  createdAt: "2026-02-01T00:00:00.000Z",
  decidedAt: "2026-02-02T00:00:00.000Z",
  ...over,
});
const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

describe("import step: matching people", () => {
  const planned = [person(1), person(2, { role: "admin", isActive: false }), person(3)];
  const existing = [account("acc-2", "p2@example.com", { role: "admin", isActive: true, canSelfApprove: true }), account("other", "p3@example.com", { companyId: "elsewhere" })];
  const m = matchPeople(planned, existing, COMPANY, ids());

  test("someone with an account in another company is left out; new people get ids in plan order", () => {
    assert.deepEqual(m.people.map((p) => p.key), [1, 2]);
    assert.deepEqual([...m.excluded], [3]);
    assert.deepEqual([...m.idOf], [[1, "new-1"], [2, "acc-2"]]);
    assert.deepEqual(m.conflicts.map((c) => [c.code, c.email]), [["email_in_other_company", "p3@example.com"]]);
  });

  test("an existing account keeps its state, so the active admins count it; none left is refused", () => {
    assert.equal(activeAdminsAfter(m, []), 1);
    const none = matchPeople([person(1)], [], COMPANY, ids());
    assert.equal(activeAdminsAfter(none, [account("seed", "seed@example.com", { role: "admin" })]), 1);
    assert.throws(() => assertKeepsAnActiveAdmin(none, []), (err) => isDomainError(err, "import_refused"));
  });

  test("new accounts are rows for the people without one; an existing account keeps a higher role and its self-approval", () => {
    const departments = new Map([[10, "dept-10"]]);
    assert.deepEqual(newAccountRows(m, COMPANY, departments), [
      {
        id: "new-1",
        companyId: COMPANY,
        email: "p1@example.com",
        name: "Person 1",
        role: "employee",
        departmentId: "dept-10",
        canSelfApprove: false,
        isActive: true,
        createdAt: new Date("2020-01-01T12:00:00.000Z"),
      },
    ]);
    const withManager = matchPeople([person(1, { managerKey: 2 }), person(2, { role: "employee" })], existing, COMPANY, ids());
    assert.deepEqual(personAfterImport(withManager, at(withManager.people, 1), departments), {
      name: "Person 2",
      role: "admin",
      departmentId: "dept-10",
      managerId: null,
      canSelfApprove: true,
    });
    assert.equal(personAfterImport(withManager, first(withManager.people), departments).managerId, "acc-2");
  });
});

describe("import step: leave types", () => {
  const planned: PlannedLeaveType = {
    key: "HOLIDAY",
    name: "Holiday",
    color: "#0f766e",
    countsAgainstAllowance: true,
    defaultAllowanceDays: 25,
    carryoverEnabled: true,
    carryoverMaxDays: 5,
    sortOrder: 0,
    pool: true,
    timeoffTypeIds: [1, 2],
  };

  test("a planned type updates the company's type with its code or name (each once), with TimeOff's settings", () => {
    const existing = [
      { id: "a", code: "VAC", name: " holiday " },
      { id: "b", code: "HOLIDAY", name: "Other" },
    ];
    assert.equal(matchingLeaveType(planned, existing, new Set())?.id, "a");
    assert.equal(matchingLeaveType(planned, existing, new Set(["a"]))?.id, "b");
    assert.equal(matchingLeaveType(planned, existing, new Set(["a", "b"])), undefined);
    assert.deepEqual(leaveTypeSettings(planned), { countsAgainstAllowance: true, defaultAllowanceDays: 25, carryoverEnabled: true, carryoverMaxDays: 5, sortOrder: 0 });
  });
});

describe("import step: allowances and requests", () => {
  const idOf = new Map([
    [1, "user-1"],
    [2, "user-2"],
  ]);

  test("allowance rows are the pool type's, per imported person and year", () => {
    const rows = allowanceRows(
      [{ personKey: 1, leaveTypeKey: "HOLIDAY", year: 2026, days: 25, adjustmentDays: 2, carriedOverDays: 3, timeoffAdjustment: 2, employmentAdjustment: 0 }],
      idOf,
      "type-pool",
    );
    assert.deepEqual(rows, [{ userId: "user-1", leaveTypeId: "type-pool", year: 2026, days: 25, carriedOverDays: 3, adjustmentDays: 2 }]);
  });

  test("a decided request keeps TimeOff's decider; a pending one goes to OOOhm's approver, and its audit row names TimeOff's", () => {
    const c = { companyId: COMPANY, idOf, typeIdOf: new Map([["HOLIDAY", "type-pool"]]), pendingApprover: new Map([["user-1", "admin-1"]]), newId: ids() };
    const [decided, pending, undated] = take(requestRows(
      [request(), request({ status: "pending", decidedAt: null, part: 2, parts: 3 }), request({ createdAt: null, decidedAt: null })],
      c,
    ), 3);
    assert.deepEqual(
      [decided.request.id, decided.request.approverId, decided.request.decidedAt?.toISOString(), decided.request.createdAt?.toISOString()],
      ["new-1", "user-2", "2026-02-02T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
    );
    assert.deepEqual([pending.request.approverId, pending.request.decidedAt], ["admin-1", null]);
    // Never "now": a request with no dates is dated from its start, and decided then.
    assert.deepEqual([undated.request.createdAt?.toISOString(), undated.request.decidedAt?.toISOString()], ["2026-03-02T00:00:00.000Z", "2026-03-02T00:00:00.000Z"]);
    assert.deepEqual(requestAuditAfter(pending), {
      status: "pending",
      leaveTypeId: "type-pool",
      startDate: "2026-03-02",
      endDate: "2026-03-02",
      dayPortion: "full",
      days: 1,
      approverId: "admin-1",
      timeoffApproverId: "user-2",
      decidedAt: null,
      timeoffLeaveId: 500,
      part: "2 of 3",
    });
    assert.equal(requestAuditAfter(decided).timeoffApproverId, undefined);
  });

  test("audit rows name the importer as their source", () => {
    assert.deepEqual(entry(COMPANY, "import.holiday", "holiday", "h-1", null, null, { date: "2026-12-25" }).after, { date: "2026-12-25", source: "import:timeoff" });
  });
});

describe("import step: reconciliation and the report", () => {
  const timeoff = timeOffYearBalance({ year: 2026, nominal: 25, startDate: null, endDate: null, adjustment: 0, carriedOver: 0, used: 5 });
  const expected = { personKey: 1, year: 2026, timeoff };
  const tracked = { tracked: true as const, allowance: 25, carriedOver: 0, adjustment: 0, total: 25, used: 5, pending: 1, carriedOut: 2, remaining: 17 };

  test("OOOhm's remaining is put on TimeOff's footing: pending and carried-out days count as left", () => {
    const row = reconciliationRow(expected, { email: "p1@example.com", name: "Person 1" }, tracked);
    assert.deepEqual([row.timeoff, row.ooohm, row.diff, row.pending], [20, 20, 0, 1]);
    const untracked = reconciliationRow(expected, { email: "p1@example.com", name: "Person 1" }, { tracked: false, used: 0, pending: 0 });
    assert.deepEqual([untracked.ooohm, untracked.diff], [null, null]);
  });

  test("a mismatch says why: TimeOff's own count, the rollover's carry, or no allowance", () => {
    const plan = { leaveCostDifferences: [{ personKey: 1, timeoffLeaveId: 9, year: 2026, timeoff: 1, ooohm: 0.5, reason: "half_day_rule" as const }] };
    assert.deepEqual(mismatchReasons(expected, { ooohm: null }, { plan, carry: { before: 3, after: 5 }, currentYear: 2026 }), [
      "TimeOff leave 9: TimeOff takes 1 day(s) in 2026 (its half-day rule), OOOhm counts 0.5.",
      "Carried over into 2026: TimeOff stored 3, OOOhm's year rollover computes 5 from 2025.",
      "OOOhm has no allowance for 2026 (outside their employment dates in TimeOff).",
    ]);
    assert.deepEqual(mismatchReasons(expected, { ooohm: 19 }, { plan: { leaveCostDifferences: [] }, carry: undefined, currentYear: 2026 }), [
      "No known cause; compare the TimeOff detail with the person's OOOhm allowance page.",
    ]);
  });

  const plan = {
    departments: [{ key: 10, name: "Ops" }],
    holidays: [{ date: "2026-12-25", name: "Christmas", timeoffId: 1 }, { date: "2026-12-26", name: "Boxing Day", timeoffId: 2 }],
    leaveTypes: [{ key: "HOLIDAY", pool: true, timeoffTypeIds: [1, 2] }],
    requests: [request({ personKey: 3 }), request({ personKey: 3, part: 2, parts: 2 })],
    skipped: { users: 1, leaves: 2 },
  } as unknown as ImportPlan;
  const m = matchPeople([person(1), person(2, { isActive: false }), person(3)], [account("other", "p3@example.com", { companyId: "elsewhere" })], COMPANY, ids());
  const poolRow = { id: "type-pool", code: "HOLIDAY", name: "Holiday" } as Parameters<typeof poolLeaveType>[0];
  const requests = requestRows([request(), request({ status: "pending" })], { companyId: COMPANY, idOf: m.idOf, typeIdOf: new Map([["HOLIDAY", "t"]]), pendingApprover: new Map(), newId: ids() });
  const writes = { departmentsCreated: 1, leaveTypes: { created: 1, updated: 0, archived: 0 }, holidaysCreated: 1, accountsCreated: 2, allowances: [], requests, poolRow };

  test("the counts add up what was planned, written and left out", () => {
    assert.deepEqual(importCounts(plan, m, writes), {
      people: { created: 2, updated: 0, active: 1, inactive: 1 },
      departments: { created: 1, reused: 0 },
      leaveTypes: { created: 1, updated: 0, archived: 0 },
      holidays: { created: 1, alreadyThere: 1 },
      allowances: 0,
      leaveRequests: { total: 2, pending: 1, approved: 1, rejected: 0, cancelled: 0 },
      skipped: { users: 2, leaves: 3 },
    });
    assert.deepEqual(poolLeaveType(poolRow, plan, { leaveTypes: [{ id: 1, name: "Holiday" }, { id: 2, name: "Training" }, { id: 3, name: "Sick" }] as never }), {
      code: "HOLIDAY",
      name: "Holiday",
      mergedFrom: ["Holiday", "Training"],
    });
  });

  test("the outcome is a dry run without apply, rolled back over a current-year mismatch, and applied otherwise; the event carries counts only", () => {
    const run = {
      input: { apply: true, acceptMismatch: false, actorEmail: "Admin@Example.com", source: { sha256: "a".repeat(64), fileName: "t.sqlite" }, snapshot: { leaveTypes: [] } },
      company: { id: COMPANY, name: "Acme", timezone: "UTC", workingDays: [1, 2, 3, 4, 5] },
      created: false,
      plan,
      warnings: [],
      conflicts: [],
    } as unknown as ImportRun;
    const source = { kind: "user", userId: "admin-1" } as unknown as Parameters<typeof importReport>[4];
    const clean = { currentYear: 2026, rows: [], mismatches: [], currentYearMismatches: 0 };
    const report = importReport(run, m, writes, clean, source);
    assert.deepEqual([report.outcome, report.actor], ["applied", { userId: "admin-1", email: "admin@example.com" }]);
    assert.equal(importReport({ ...run, input: { ...run.input, apply: false } }, m, writes, clean, source).outcome, "dry_run");
    const blocked = { ...clean, mismatches: [{} as never], currentYearMismatches: 1 };
    assert.equal(importReport(run, m, writes, blocked, source).outcome, "rolled_back");
    assert.deepEqual(completedPayload("run-1", report, plan, m, 1), {
      importRunId: "run-1",
      source: "timeoff",
      sourceSha256: "a".repeat(64),
      counts: { people: 2, departments: 1, leaveTypes: 1, holidays: 1, allowances: 0, leaveRequests: 2 },
      mismatches: 0,
    });
  });
});

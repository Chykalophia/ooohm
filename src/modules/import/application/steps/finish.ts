import "server-only";
import { type LeaveTypeSettingsDTO as LeaveTypeRow } from "@/modules/organisation";
/**
 * Import steps: the report, and, for an applied import, the `import_runs` row and the one
 * `import.completed` event.
 */
import type { UserChangeSource } from "@/shared/kernel/change-source";
import { IMPORT_AUDIT_ACTIONS, IMPORT_EVENT_TYPES, type ImportCompletedPayload, type Unattributed } from "@/shared/kernel/events";
import { insertImportRun } from "@/modules/import/infrastructure/drizzle-import.repository";
import { recordChange } from "@/shared/lib/db/change-log";
import type { ImportPlan, PlannedAllowance } from "@/modules/import/domain/timeoff/plan/types";
import type { TimeOffSnapshot } from "@/modules/import/domain/timeoff/source";
import { type ImportCounts, type Reconciliation, TIMEOFF_IMPORT_SOURCE, type TimeOffImportReport } from "@/modules/import/application/report";
import type { ImportedRequest } from "./apply-leave";
import { activeAfterImport, type MatchedPeople } from "./match-people";
import { actorEmailOf, entry, type ImportRun } from "./run";

/** What the write steps did, for the counts. */
export interface ImportWrites {
  departmentsCreated: number;
  leaveTypes: ImportCounts["leaveTypes"];
  holidaysCreated: number;
  accountsCreated: number;
  allowances: readonly PlannedAllowance[];
  requests: readonly ImportedRequest[];
  poolRow: LeaveTypeRow | null;
}

/** The report's counts. */
export function importCounts(plan: ImportPlan, m: MatchedPeople, w: ImportWrites): ImportCounts {
  const withStatus = (status: string) => w.requests.filter((r) => r.request.status === status).length;
  return {
    people: {
      created: w.accountsCreated,
      updated: m.people.length - w.accountsCreated,
      active: m.people.filter((p) => activeAfterImport(m, p)).length,
      inactive: m.people.filter((p) => !activeAfterImport(m, p)).length,
    },
    departments: { created: w.departmentsCreated, reused: plan.departments.length - w.departmentsCreated },
    leaveTypes: w.leaveTypes,
    holidays: { created: w.holidaysCreated, alreadyThere: plan.holidays.length - w.holidaysCreated },
    allowances: w.poolRow ? w.allowances.length : 0,
    leaveRequests: { total: w.requests.length, pending: withStatus("pending"), approved: withStatus("approved"), rejected: withStatus("rejected"), cancelled: withStatus("cancelled") },
    skipped: {
      users: plan.skipped.users + m.excluded.size,
      leaves: plan.skipped.leaves + plan.requests.filter((r) => m.excluded.has(r.personKey) && r.part === 1).length,
    },
  };
}

/** The pool type, and the TimeOff types merged into it. */
export function poolLeaveType(poolRow: LeaveTypeRow | null, plan: ImportPlan, snapshot: Pick<TimeOffSnapshot, "leaveTypes">): TimeOffImportReport["poolLeaveType"] {
  if (!poolRow) return null;
  const merged = plan.leaveTypes.find((p) => p.pool)?.timeoffTypeIds;
  return { code: poolRow.code, name: poolRow.name, mergedFrom: snapshot.leaveTypes.filter((t) => merged?.includes(t.id)).map((t) => t.name) };
}

/** The report. Its outcome: `dry_run` without `apply`; `rolled_back` when a current-year balance differs (unless accepted); else `applied`. */
export function importReport(run: ImportRun, m: MatchedPeople, w: ImportWrites, reconciliation: Reconciliation, source: UserChangeSource): TimeOffImportReport {
  const { input, company } = run;
  const blocked = reconciliation.currentYearMismatches > 0 && !input.acceptMismatch;
  return {
    outcome: !input.apply ? "dry_run" : blocked ? "rolled_back" : "applied",
    source: input.source,
    company: { id: company.id, name: company.name, created: run.created, timezone: company.timezone, workingDays: company.workingDays },
    actor: { userId: source.userId, email: actorEmailOf(input.actorEmail) },
    importRunId: null,
    poolLeaveType: poolLeaveType(w.poolRow, run.plan, input.snapshot),
    counts: importCounts(run.plan, m, w),
    reconciliation,
    warnings: run.warnings,
    conflicts: run.conflicts,
  };
}

/** `import.completed`'s payload: counts and the file's hash, never a name or email. */
export function completedPayload(importRunId: string, report: TimeOffImportReport, plan: ImportPlan, m: MatchedPeople, holidaysCreated: number): Unattributed<ImportCompletedPayload> {
  return {
    importRunId,
    source: TIMEOFF_IMPORT_SOURCE,
    sourceSha256: report.source.sha256,
    counts: {
      people: m.people.length,
      departments: plan.departments.length,
      leaveTypes: plan.leaveTypes.length,
      holidays: holidaysCreated,
      allowances: report.counts.allowances,
      leaveRequests: report.counts.leaveRequests.total,
    },
    mismatches: report.reconciliation.mismatches.length,
  };
}

/** Records the applied import: its `import_runs` row (which makes the file and company refuse a second import) and `import.completed`. */
export async function commitRun(run: ImportRun, m: MatchedPeople, report: TimeOffImportReport, source: UserChangeSource, holidaysCreated: number): Promise<TimeOffImportReport> {
  const { input, company } = run;
  const row = await insertImportRun(run.tx, {
    companyId: company.id,
    source: TIMEOFF_IMPORT_SOURCE,
    sourceSha256: input.source.sha256,
    sourceFileName: input.source.fileName,
    counts: report.counts,
    report: { ...report, importRunId: null },
  });
  report.importRunId = row.id;
  const payload = completedPayload(row.id, report, run.plan, m, holidaysCreated);
  await recordChange(run.tx, {
    source,
    // Flat fields, so the audit viewer can show them; the full counts are in import_runs.
    audit: entry(company.id, IMPORT_AUDIT_ACTIONS.completed, "import_run", row.id, null, null, {
      fileName: input.source.fileName,
      sourceSha256: input.source.sha256,
      ...payload.counts,
      mismatches: report.reconciliation.mismatches.length,
      warnings: report.warnings.length,
      conflicts: report.conflicts.length,
    }),
    event: { companyId: company.id, type: IMPORT_EVENT_TYPES.completed, payload },
  });
  return report;
}

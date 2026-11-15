import "server-only";
import { type LeaveTypeSettingsDTO as LeaveTypeRow, addDepartment as insertDepartment, addLeaveType as insertLeaveType, applyCompanyChanges as updateCompany, applyLeaveTypeChanges as updateLeaveType, listAllLeaveTypes } from "@/modules/organisation";
/**
 * Import steps: the company's settings, departments, leave types and holidays.
 */
import { IMPORT_AUDIT_ACTIONS } from "@/domain/events";
import { insertHolidays } from "@/server/repositories/holidays";
import { countRequestsByLeaveType, listDepartmentsByName } from "@/server/repositories/imports";
import { leaveTypeCodeFor } from "@/modules/import/domain/timeoff/plan/rules";
import type { PlannedLeaveType } from "@/modules/import/domain/timeoff/plan/types";
import { entry, type ImportRun, leaveTypeSnapshot } from "./run";

/** Sets the company's time zone and working days to TimeOff's when they differ (always for a new company). */
export async function applyCompanySettings(run: ImportRun): Promise<void> {
  const { company, created } = run;
  const settings = { name: company.name, timezone: run.timezone, workingDays: run.plan.company.workingDays, allowancePolicy: company.allowancePolicy };
  if (!created && settings.timezone === company.timezone && settings.workingDays.join() === company.workingDays.join()) return;
  const before = created ? null : { name: company.name, timezone: company.timezone, workingDays: company.workingDays };
  run.company = await updateCompany(run.tx, company.id, settings);
  run.audit.push(
    entry(run.company.id, IMPORT_AUDIT_ACTIONS.company, "company", run.company.id, null, before, {
      name: run.company.name,
      timezone: run.company.timezone,
      workingDays: run.company.workingDays,
      timeoffCompanyId: run.timeoffCompany.id,
    }),
  );
}

/** Creates the departments the company does not have by name (ignoring case). @returns Planned key → department id, and how many were created. */
export async function applyDepartments(run: ImportRun): Promise<{ departmentId: Map<number, string>; created: number }> {
  const byName = await listDepartmentsByName(run.tx, run.company.id);
  const departmentId = new Map<number, string>();
  let created = 0;
  for (const d of run.plan.departments) {
    const existing = byName.get(d.name.toLowerCase());
    if (existing) {
      departmentId.set(d.key, existing.id);
      continue;
    }
    const row = await insertDepartment(run.tx, { companyId: run.company.id, name: d.name });
    departmentId.set(d.key, row.id);
    created++;
    run.audit.push(entry(run.company.id, IMPORT_AUDIT_ACTIONS.department, "department", row.id, null, null, { name: row.name, timeoffDepartmentId: d.key }));
  }
  return { departmentId, created };
}

/** The settings a planned type writes. Its sort order is TimeOff's, so the pool type leads the request form (its first type is the default). */
export function leaveTypeSettings(t: PlannedLeaveType) {
  return {
    countsAgainstAllowance: t.countsAgainstAllowance,
    defaultAllowanceDays: t.defaultAllowanceDays,
    carryoverEnabled: t.carryoverEnabled,
    carryoverMaxDays: t.carryoverMaxDays,
    sortOrder: t.sortOrder,
  };
}

/** The existing type a planned one updates: same code, or same name ignoring case; each existing type is matched once. */
export function matchingLeaveType<T extends Pick<LeaveTypeRow, "id" | "code" | "name">>(t: PlannedLeaveType, existing: readonly T[], used: ReadonlySet<string>): T | undefined {
  return existing.find((e) => !used.has(e.id) && (e.code === t.key || e.name.trim().toLowerCase() === t.name.toLowerCase()));
}

export interface LeaveTypeResult {
  /** Planned key → leave type id. */
  typeIdOf: Map<string, string>;
  /** The pool type's row, when there is a pool. */
  poolRow: LeaveTypeRow | null;
  counts: { created: number; updated: number; archived: number };
}

/** Writes one planned type: updates its match (unarchiving it) or creates it under a free code. */
async function writeLeaveType(run: ImportRun, t: PlannedLeaveType, existingTypes: readonly LeaveTypeRow[], used: Set<string>, taken: Set<string>, counts: LeaveTypeResult["counts"]): Promise<LeaveTypeRow> {
  const companyId = run.company.id;
  const match = matchingLeaveType(t, existingTypes, used);
  if (match) {
    used.add(match.id);
    const row = await updateLeaveType(run.tx, companyId, match.id, { ...leaveTypeSettings(t), archivedAt: null });
    counts.updated++;
    run.audit.push(entry(companyId, IMPORT_AUDIT_ACTIONS.leaveType, "leave_type", row.id, null, leaveTypeSnapshot(match), { ...leaveTypeSnapshot(row), timeoffLeaveTypeIds: t.timeoffTypeIds }));
    return row;
  }
  const code = taken.has(t.key) ? leaveTypeCodeFor(t.name, taken) : t.key;
  taken.add(code);
  const row = await insertLeaveType(run.tx, { companyId, code, name: t.name, color: t.color, isPaid: true, ...leaveTypeSettings(t) });
  used.add(row.id);
  counts.created++;
  run.audit.push(entry(companyId, IMPORT_AUDIT_ACTIONS.leaveType, "leave_type", row.id, null, null, { ...leaveTypeSnapshot(row), timeoffLeaveTypeIds: t.timeoffTypeIds }));
  return row;
}

/** Writes the planned types, then archives the company's other types, except those with requests (kept, after the imported ones). */
export async function applyLeaveTypes(run: ImportRun): Promise<LeaveTypeResult> {
  const existingTypes = await listAllLeaveTypes(run.tx, run.company.id);
  const used = new Set<string>();
  const taken = new Set(existingTypes.map((t) => t.code));
  const result: LeaveTypeResult = { typeIdOf: new Map(), poolRow: null, counts: { created: 0, updated: 0, archived: 0 } };
  for (const t of run.plan.leaveTypes) {
    const row = await writeLeaveType(run, t, existingTypes, used, taken, result.counts);
    result.typeIdOf.set(t.key, row.id);
    if (t.pool) result.poolRow = row;
  }
  await archiveOtherTypes(run, existingTypes.filter((x) => !used.has(x.id) && x.archivedAt === null), result.counts);
  return result;
}

async function archiveOtherTypes(run: ImportRun, others: readonly LeaveTypeRow[], counts: LeaveTypeResult["counts"]): Promise<void> {
  const requestsByType = await countRequestsByLeaveType(run.tx, run.company.id);
  let nextSortOrder = run.plan.leaveTypes.length;
  for (const e of others) {
    if ((requestsByType.get(e.id) ?? 0) > 0) {
      await updateLeaveType(run.tx, run.company.id, e.id, { sortOrder: nextSortOrder++ });
      run.warnings.push({ code: "leave_type_kept", message: `Leave type "${e.name}" is not in TimeOff but has requests; left active, after the imported types.` });
      continue;
    }
    const row = await updateLeaveType(run.tx, run.company.id, e.id, { archivedAt: run.ctx.now() });
    counts.archived++;
    run.audit.push(entry(run.company.id, IMPORT_AUDIT_ACTIONS.leaveType, "leave_type", row.id, null, leaveTypeSnapshot(e), leaveTypeSnapshot(row)));
  }
}

/** Adds TimeOff's holidays; dates the company already has are left as they are. @returns The holidays created. */
export async function applyHolidays(run: ImportRun) {
  const rows = await insertHolidays(
    run.tx,
    run.company.id,
    run.plan.holidays.map((h) => ({ date: h.date, name: h.name })),
  );
  for (const h of rows) {
    run.audit.push(entry(run.company.id, IMPORT_AUDIT_ACTIONS.holiday, "holiday", h.id, null, null, { date: h.date, name: h.name }));
  }
  return rows;
}

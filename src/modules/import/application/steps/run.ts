import "server-only";
import { type CompanyDTO as CompanyRow, type LeaveTypeSettingsDTO as LeaveTypeRow } from "@/modules/organisation";
/**
 * What every step of one TimeOff import shares, and how a step writes its audit rows.
 */
import type { Transaction } from "@/db/types";
import type { CalendarDate } from "@/domain/calendar-date";
import { DomainError } from "@/domain/errors";
import { normalizeEmail } from "@/shared/kernel/names";
import type { ServiceContext } from "@/server/context";
import type { ExistingAccount } from "@/server/repositories/imports";
import type { AuditEntry } from "@/shared/lib/db/change-log";
import type { ImportIssue, ImportPlan } from "@/modules/import/domain/timeoff/plan/types";
import type { TimeOffCompany } from "@/modules/import/domain/timeoff/source";
import type { TimeOffImportInput } from "@/modules/import/application/report";

const AUDIT_SOURCE = "import:timeoff";

/** One import in progress, inside its transaction. Steps append to `audit`, `warnings` and `conflicts`, and may replace `company`. */
export interface ImportRun {
  ctx: ServiceContext;
  tx: Transaction;
  input: TimeOffImportInput;
  timeoffCompany: TimeOffCompany;
  company: CompanyRow;
  created: boolean;
  /** The target company's accounts before the import (none for a new company). */
  accounts: ExistingAccount[];
  timezone: string;
  today: CalendarDate;
  currentYear: number;
  plan: ImportPlan;
  warnings: ImportIssue[];
  conflicts: ImportIssue[];
  /** Audit rows of the imported records, written together once people are in. */
  audit: AuditEntry[];
}

export function refuse(message: string): never {
  throw new DomainError("import_refused", message);
}

/** An `import.*` audit row; its `after` names the importer as its source. */
export function entry(
  companyId: string,
  action: string,
  entityType: string,
  entityId: string,
  subjectUserId: string | null,
  before: unknown,
  after: object,
): AuditEntry {
  return { companyId, action, entityType, entityId, subjectUserId, before, after: { ...after, source: AUDIT_SOURCE } };
}

/** `actorEmail` as stored, or a refusal that says which flag was wrong. */
export function actorEmailOf(raw: string): string {
  try {
    return normalizeEmail(raw);
  } catch {
    throw new DomainError("invalid_input", `--actor "${raw}" isn't an email address. Name the admin who is running the import.`);
  }
}

export function leaveTypeSnapshot(t: LeaveTypeRow) {
  return {
    code: t.code,
    name: t.name,
    color: t.color,
    countsAgainstAllowance: t.countsAgainstAllowance,
    defaultAllowanceDays: t.defaultAllowanceDays,
    carryoverEnabled: t.carryoverEnabled,
    carryoverMaxDays: t.carryoverMaxDays,
    sortOrder: t.sortOrder,
    archived: t.archivedAt !== null,
  };
}

export function accountSnapshot(a: ExistingAccount) {
  return { name: a.name, role: a.role, departmentId: a.departmentId, managerId: a.managerId, canSelfApprove: a.canSelfApprove, isActive: a.isActive };
}

export type AllowanceSnapshotInput = { userId: string; leaveTypeId: string; year: number; days: number; carriedOverDays: number; adjustmentDays: number };

export function allowanceSnapshot(r: AllowanceSnapshotInput) {
  return { userId: r.userId, leaveTypeId: r.leaveTypeId, year: r.year, days: r.days, carriedOverDays: r.carriedOverDays, adjustmentDays: r.adjustmentDays };
}

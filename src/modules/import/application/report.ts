import "server-only";
/**
 * What the TimeOff import takes and reports.
 */
import type { TimeOffYearBalance } from "@/modules/import/domain/timeoff/balance";
import type { ImportIssue } from "@/modules/import/domain/timeoff/plan/types";
import type { TimeOffSnapshot } from "@/modules/import/domain/timeoff/source";

/** `audit_log.after.source` and `import_runs.source` of this importer. */
export const TIMEOFF_IMPORT_SOURCE = "timeoff";

export interface TimeOffImportInput {
  snapshot: TimeOffSnapshot;
  /** The source file: its SHA-256 (hex) and base name. */
  source: { sha256: string; fileName: string };
  /** An existing company, or a name for a new one. */
  target: { companyId: string } | { createCompany: string };
  /**
   * Email of the admin running the import (the CLI's `--actor`). Every change is
   * recorded as theirs, via `timeoff_import`. Must be an active admin of the target
   * company once people are imported; otherwise the import is refused.
   */
  actorEmail: string;
  /** The TimeOff company to read, when the file holds several. */
  timeoffCompanyId?: number;
  /** See `ImportPlanOptions.poolTypeName`. */
  poolType?: string;
  mergePoolTypes?: boolean;
  /** Commit. Without it the whole import runs and rolls back (a dry run). */
  apply?: boolean;
  /** Import into a company that already has leave requests or non-admin members. */
  force?: boolean;
  /** Commit even when a current-year balance differs from TimeOff's. */
  acceptMismatch?: boolean;
}

/** One person's balance in one year, on both sides. */
export interface ReconciliationRow {
  email: string;
  name: string;
  year: number;
  /** TimeOff's remaining (total − approved days). */
  timeoff: number;
  /**
   * OOOhm's remaining on the same footing: total − approved days, i.e. the balance the
   * dashboard shows plus pending days and days already carried into the next year (both
   * of which OOOhm subtracts and TimeOff does not). `null` when OOOhm tracks no
   * allowance for that year.
   */
  ooohm: number | null;
  /** ooohm − timeoff; `null` when OOOhm has nothing to compare. */
  diff: number | null;
  /** OOOhm's pending days in the year (TimeOff's "new" leave), shown apart on both sides. */
  pending: number;
  /** TimeOff's figure, part by part. */
  detail: TimeOffYearBalance;
}

export interface ReconciliationMismatch extends ReconciliationRow {
  /** Why the two differ, as far as the importer can tell. */
  reasons: string[];
}

export interface ImportCounts {
  people: { created: number; updated: number; active: number; inactive: number };
  departments: { created: number; reused: number };
  leaveTypes: { created: number; updated: number; archived: number };
  holidays: { created: number; alreadyThere: number };
  allowances: number;
  leaveRequests: { total: number; pending: number; approved: number; rejected: number; cancelled: number };
  skipped: { users: number; leaves: number };
}

export interface Reconciliation {
  currentYear: number;
  rows: ReconciliationRow[];
  mismatches: ReconciliationMismatch[];
  /** Mismatches in the current year: these block `apply`. */
  currentYearMismatches: number;
}

export interface TimeOffImportReport {
  /**
   * `dry_run`: nothing was written. `applied`: committed. `rolled_back`: `apply` was asked
   * for but a current-year balance differs, so nothing was written.
   */
  outcome: "dry_run" | "applied" | "rolled_back";
  source: { sha256: string; fileName: string };
  company: { id: string; name: string; created: boolean; timezone: string; workingDays: number[] };
  /** The admin who ran it (`--actor`), whom every change is attributed to. */
  actor: { userId: string; email: string };
  importRunId: string | null;
  poolLeaveType: { code: string; name: string; mergedFrom: string[] } | null;
  counts: ImportCounts;
  reconciliation: Reconciliation;
  warnings: ImportIssue[];
  conflicts: ImportIssue[];
}

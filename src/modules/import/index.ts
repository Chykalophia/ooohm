import "server-only";
/**
 * The import module's public API (see README.md): the one-time TimeOff.Management import.
 * It is CLI-only (`scripts/import-timeoff.mts`): it has no actor or session, so nothing
 * in src/app may import it (lint enforces it).
 */
export { importTimeOff } from "./application/import-timeoff";
export { readTimeOffFile } from "./application/queries/read-timeoff-file";
export { TIMEOFF_IMPORT_SOURCE } from "./application/report";
export type {
  ImportCounts,
  Reconciliation,
  ReconciliationMismatch,
  TimeOffImportInput,
  TimeOffImportReport,
} from "./application/report";
export type { ImportIssue } from "./domain/timeoff/plan/types";
export type { TimeOffSnapshot } from "./domain/timeoff/source";

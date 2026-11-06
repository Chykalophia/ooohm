import { personLabel } from "@/domain/person";
import type { PeopleImportPlan } from "@/domain/people-import";
import { ROLE_LABEL } from "@/lib/format";

/** One row of the file as the preview lists it. */
export interface ImportPreviewRow {
  line: number;
  email: string;
  name: string;
  status: "add" | "skip" | "error";
  /** For an add, what they get; for a skip, why; for a problem, every problem. */
  details: string;
}

/** What the import page shows: nothing yet, a refusal, a checked file, or the outcome. */
export type ImportState =
  | { status: "idle" }
  | { status: "error"; message: string; fields?: string[] }
  | {
      status: "preview";
      id: string;
      /** The checked file's text, sent back as is when the admin goes ahead. */
      csv: string;
      fileName: string;
      adds: number;
      skips: number;
      errors: number;
      newDepartments: string[];
      ignoredColumns: string[];
      rows: ImportPreviewRow[];
      /** Why going ahead was refused (the company changed since the check), if it was. */
      problem?: string;
    }
  | { status: "imported"; id: string; message: string };

export const IMPORT_IDLE: ImportState = { status: "idle" };

/** The preview of a plan, as plain data for the page. */
export function previewRows(plan: PeopleImportPlan): ImportPreviewRow[] {
  return plan.rows.map((row) => {
    if (row.status === "error") return { line: row.line, email: row.email, name: row.name, status: "error", details: row.problems.join(" ") };
    if (row.status === "skip") return { line: row.line, email: row.email, name: "", status: "skip", details: row.reason };
    const p = row.person;
    const details = [
      ROLE_LABEL[p.role],
      p.department?.name,
      p.manager ? `Reports to ${p.manager.email}` : "No manager",
      p.canSelfApprove ? "Approves own requests" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return { line: row.line, email: row.email, name: personLabel(p), status: "add", details };
  });
}

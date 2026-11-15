import "server-only";
import { randomUUID } from "node:crypto";
import type { DomainError } from "@/shared/kernel/errors";
import { PEOPLE_IMPORT_HOURLY_LIMIT, type PeopleImportPreview, type PeopleImportResult } from "@/modules/people";
import { type ImportState, previewRows } from "./import-state";

/** Largest file accepted: far more than the row limit needs, well inside a server action's body limit. */
export const MAX_FILE_BYTES = 512 * 1024;

const RATE_LIMITED = `That's more than ${PEOPLE_IMPORT_HOURLY_LIMIT} people imported in an hour. Try again later.`;

/** The words for a refused check or import. `invalid_input` carries its own, written for the file. */
export function refusalOf(err: DomainError): string | null {
  if (err.code === "invalid_input") return err.message || "That file can't be imported.";
  if (err.code === "rate_limited") return RATE_LIMITED;
  if (err.code === "forbidden") return "Only admins can import people.";
  if (err.code === "already_exists") return "Someone in the file was just added another way. Check the file again.";
  return null;
}

/** The uploaded file's text and name, or why it can't be checked. */
export async function readUpload(file: File | undefined): Promise<{ csv: string; fileName: string } | ImportState> {
  if (!file || file.size === 0) return { status: "error", message: "Choose a CSV file first.", fields: ["file"] };
  if (file.size > MAX_FILE_BYTES) return { status: "error", message: "That file is too big for one import. Split it into smaller files.", fields: ["file"] };
  return { csv: await file.text(), fileName: file.name.slice(0, 300) };
}

/** A checked file as the page shows it, with what refused the import when there was a refusal. */
export function previewState(plan: PeopleImportPreview, csv: string, fileName: string, problem?: string): ImportState {
  return {
    status: "preview",
    id: randomUUID(),
    csv,
    fileName,
    adds: plan.adds,
    skips: plan.skips,
    errors: plan.errors,
    newDepartments: plan.newDepartments,
    ignoredColumns: plan.ignoredColumns,
    rows: previewRows(plan),
    ...(problem ? { problem } : {}),
  };
}

/** What an import did, in a sentence. */
export function importedState(result: PeopleImportResult, sendInvites: boolean): ImportState {
  if (result.added === 0) {
    return { status: "imported", id: randomUUID(), message: "Nobody was added: everyone in the file already has an account." };
  }
  const people = `${result.added} ${result.added === 1 ? "person" : "people"}`;
  const departments = result.departmentsCreated > 0 ? ` and ${result.departmentsCreated} ${result.departmentsCreated === 1 ? "department" : "departments"}` : "";
  const invites = sendInvites ? " Each will get an email with a sign-in link." : " No invites were sent; they can sign in from the sign-in page.";
  return { status: "imported", id: randomUUID(), message: `Added ${people}${departments}.${invites}` };
}

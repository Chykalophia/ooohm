"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type DomainError, isDomainError } from "@/domain/errors";
import { importPeople, PEOPLE_IMPORT_HOURLY_LIMIT, previewPeopleImport } from "@/server/services/admin-people-import";
import { adminStateAction } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";
import { type ImportState, previewRows } from "./import-state";

/** Largest file accepted: far more than the row limit needs, well inside a server action's body limit. */
const MAX_FILE_BYTES = 512 * 1024;

const importSchema = z.object({
  intent: z.enum(["check", "import"]),
  file: z.instanceof(File).optional(),
  csv: z.string().max(MAX_FILE_BYTES).optional(),
  fileName: formFields.text(300).optional(),
  sendInvites: formFields.checkbox,
});

const RATE_LIMITED = `That's more than ${PEOPLE_IMPORT_HOURLY_LIMIT} people imported in an hour. Try again later.`;

/** The words for a refused check or import. `invalid_input` carries its own, written for the file. */
function refusalOf(err: DomainError): string | null {
  if (err.code === "invalid_input") return err.message || "That file can't be imported.";
  if (err.code === "rate_limited") return RATE_LIMITED;
  if (err.code === "already_exists") return "Someone in the file was just added another way. Check the file again.";
  return null;
}

/**
 * Import page. `check` reads the uploaded file and returns what importing it would do,
 * writing nothing; `import` imports the checked file (sent back as text), planning it
 * again first. A refused import comes back as a fresh check that says why.
 */
export async function peopleImportAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  return adminStateAction(
    "people_import",
    formData,
    importSchema,
    async (ctx, actor, input): Promise<ImportState> => {
      let csv = input.csv ?? "";
      let fileName = input.fileName ?? "";
      if (input.intent === "check") {
        if (!input.file || input.file.size === 0) return { status: "error", message: "Choose a CSV file first.", fields: ["file"] };
        if (input.file.size > MAX_FILE_BYTES) return { status: "error", message: "That file is too big for one import. Split it into smaller files.", fields: ["file"] };
        csv = await input.file.text();
        fileName = input.file.name.slice(0, 300);
      }

      const check = async (problem?: string): Promise<ImportState> => {
        const plan = await previewPeopleImport(ctx, actor, csv);
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
      };

      try {
        if (input.intent === "check") return await check();
        const result = await importPeople(ctx, actor, { csv, sendInvites: input.sendInvites });
        const people = `${result.added} ${result.added === 1 ? "person" : "people"}`;
        const departments = result.departmentsCreated > 0 ? ` and ${result.departmentsCreated} ${result.departmentsCreated === 1 ? "department" : "departments"}` : "";
        const invites = result.added === 0 ? "" : input.sendInvites ? " Each will get an email with a sign-in link." : " No invites were sent; they can sign in from the sign-in page.";
        return { status: "imported", id: randomUUID(), message: `Added ${people}${departments}.${invites}` };
      } catch (err) {
        const message = isDomainError(err) ? refusalOf(err) : null;
        if (message === null) throw err;
        if (input.intent === "check") return { status: "error", message, fields: ["file"] };
        return check(message).catch(() => ({ status: "error", message }) as const);
      }
    },
  );
}

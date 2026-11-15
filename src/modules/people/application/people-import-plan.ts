import "server-only";
/** Plans a people CSV against the company as an executor sees it (the pool for a preview, the import's transaction). */
import type { Executor } from "@/db/types";
import { listDepartments } from "@/modules/organisation";
import { type ImportFacts, type PeopleImportPlan, planPeopleImport, readPeopleCsv } from "@/modules/people/domain/people-import";
import { emailsInUse } from "@/modules/people/infrastructure/drizzle-people.repository";
import { listPeopleNames } from "@/shared/lib/db/members";

/** A plan, with the headers of the file's columns that the import ignores. */
export type PeopleImportPreview = PeopleImportPlan & { ignoredColumns: string[] };

/** The facts a plan needs, read with `ex`. */
async function loadImportFacts(ex: Executor, companyId: string, emails: readonly string[]): Promise<ImportFacts> {
  const [people, taken, departments] = await Promise.all([listPeopleNames(ex, companyId), emailsInUse(ex, emails), listDepartments(ex, companyId)]);
  return {
    members: new Map(people.map((p) => [p.email, { id: p.id, isActive: p.isActive }])),
    takenEmails: taken,
    departments: new Map(departments.map((d) => [d.name.toLowerCase(), { id: d.id, name: d.name }])),
  };
}

/**
 * Reads the file and plans it against the company as `ex` sees it.
 *
 * @throws DomainError `invalid_input` when the file cannot be read as an import file.
 */
export async function planPeopleFile(ex: Executor, companyId: string, csv: string): Promise<PeopleImportPreview> {
  const { rows, ignoredColumns } = readPeopleCsv(csv);
  // Every address the file mentions, people and managers alike, lowercased as stored.
  const emails = [...new Set(rows.flatMap((r) => [r.email, r.managerEmail]).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  return { ...planPeopleImport(rows, await loadImportFacts(ex, companyId, emails)), ignoredColumns };
}

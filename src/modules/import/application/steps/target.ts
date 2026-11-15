import "server-only";
import { type CompanyDTO as CompanyRow, lockCompanyForChange as lockCompany } from "@/modules/organisation";
/**
 * Import steps: refuse a file seen before, find (or create) the target company and check
 * it may take the import, then plan the import for it.
 */
import type { Transaction } from "@/db/types";
import { type CalendarDate } from "@/shared/kernel/calendar-date";
import { COMPANY_NAME_MAX_LENGTH } from "@/shared/kernel/company-settings";
import { isUuid } from "@/shared/kernel/uuid";
import { oneLine } from "@/shared/kernel/text";
import { todayInTimeZone, yearInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { listHolidayRows } from "@/modules/calendar";
import {
  countCompanyLeaveRequests,
  type ExistingAccount,
  findImportRunByCompany,
  findImportRunBySha,
  listCompanyAccounts,
  listCompanyNames,
} from "@/modules/import/infrastructure/drizzle-import.repository";
import { insertCompany, lockCompaniesTable } from "@/shared/lib/db/company-creation";
import { buildImportPlan } from "@/modules/import/domain/timeoff/mapping";
import { timeOffTimeZone } from "@/modules/import/domain/timeoff/plan/rules";
import type { TimeOffCompany } from "@/modules/import/domain/timeoff/source";
import { TIMEOFF_IMPORT_SOURCE, type TimeOffImportInput } from "@/modules/import/application/report";
import { type ImportRun, refuse } from "./run";

export interface ImportTarget {
  company: CompanyRow;
  created: boolean;
  accounts: ExistingAccount[];
}

/** @throws DomainError `import_refused` when this file was imported before. */
export async function refuseRepeatedFile(tx: Transaction, sha256: string): Promise<void> {
  const previous = await findImportRunBySha(tx, sha256);
  if (previous) {
    refuse(`This file was already imported on ${previous.createdAt.toISOString()} (import run ${previous.id}). Importing it again would duplicate everyone's history.`);
  }
}

/** The existing company, locked. @throws DomainError `import_refused` when it is unknown or already holds a TimeOff import. */
async function existingCompany(tx: Transaction, companyId: string): Promise<CompanyRow> {
  const found = isUuid(companyId) ? await lockCompany(tx, companyId) : undefined;
  if (!found) {
    const known = (await listCompanyNames(tx)).map((c) => `${c.id} (${c.name})`).join(", ");
    refuse(`There is no company ${companyId}. Companies: ${known || "none"}.`);
  }
  // After the lock, so two imports into one company cannot both pass this check.
  const imported = await findImportRunByCompany(tx, found.id, TIMEOFF_IMPORT_SOURCE);
  if (imported) {
    refuse(
      `Company "${found.name}" already holds a TimeOff import (${imported.sourceFileName}, ${imported.createdAt.toISOString()}, import run ${imported.id}). ` +
        `Importing another export into it would add every TimeOff leave a second time, so it is refused even with --force. ` +
        `To redo the import, restore the database backup taken before it (docs/deploy.md) and import the new export once.`,
    );
  }
  return found;
}

/** A new company. @throws DomainError `import_refused` for a bad name, or when the deployment already has a company. */
async function newCompany(tx: Transaction, rawName: string, timeoffCompany: TimeOffCompany): Promise<CompanyRow> {
  const name = oneLine(rawName);
  if (name.length === 0 || name.length > COMPANY_NAME_MAX_LENGTH) refuse(`Company names are 1 to ${COMPANY_NAME_MAX_LENGTH} characters.`);
  // v1 runs one company per deployment. Locked first; the seed takes the same lock
  // before its own check, so neither it nor another import can create one meanwhile.
  await lockCompaniesTable(tx);
  const existing = await listCompanyNames(tx);
  const [first] = existing;
  if (first) {
    const known = existing.map((c) => `${c.id} (${c.name})`).join(", ");
    refuse(
      `This deployment already has a company: ${known}. OOOhm runs one company per deployment, so --create-company only works on an empty database. ` +
        `Import into the existing company with --company ${first.id} instead.`,
    );
  }
  return insertCompany(tx, { name, timezone: timeOffTimeZone(timeoffCompany) ?? "UTC", workingDays: [1, 2, 3, 4, 5] });
}

/** @throws DomainError `import_refused` when an existing company has leave requests or members besides its active admins, without `force`. */
async function assertEmpty(tx: Transaction, company: CompanyRow, accounts: readonly ExistingAccount[]): Promise<void> {
  const requests = await countCompanyLeaveRequests(tx, company.id);
  const others = accounts.filter((a) => !(a.role === "admin" && a.isActive));
  if (requests > 0 || others.length > 0) {
    refuse(
      `Company "${company.name}" already has ${requests} leave request(s) and ${others.length} member(s) besides its active admins. ` +
        `The import expects a freshly seeded company. Pass --force to import into it anyway: people with the same email are updated, not duplicated, ` +
        `and all of TimeOff's leave history is added next to the requests already there.`,
    );
  }
}

/** The company the import writes into, with its accounts, checked. */
export async function resolveTarget(tx: Transaction, input: TimeOffImportInput, timeoffCompany: TimeOffCompany): Promise<ImportTarget> {
  const created = !("companyId" in input.target);
  const company = "companyId" in input.target ? await existingCompany(tx, input.target.companyId) : await newCompany(tx, input.target.createCompany, timeoffCompany);
  const accounts = created ? [] : await listCompanyAccounts(tx, company.id);
  if (!created && !input.force) await assertEmpty(tx, company, accounts);
  return { company, created, accounts };
}

/** Plans the import for the target, in TimeOff's time zone when OOOhm knows it, and starts the run. */
export async function startRun(ctx: ServiceContext, tx: Transaction, input: TimeOffImportInput, timeoffCompany: TimeOffCompany, target: ImportTarget): Promise<ImportRun> {
  const timezone = timeOffTimeZone(timeoffCompany) ?? target.company.timezone;
  const today: CalendarDate = todayInTimeZone(timezone, ctx.now());
  const currentYear = yearInTimeZone(timezone, ctx.now());
  const existingHolidays = target.created ? [] : await listHolidayRows(tx, target.company.id, "0001-01-01", "9999-12-31");
  const plan = buildImportPlan(input.snapshot, {
    timeoffCompanyId: timeoffCompany.id,
    poolTypeName: input.poolType,
    mergePoolTypes: input.mergePoolTypes,
    currentYear,
    today,
    existingHolidays: new Set(existingHolidays.map((h) => h.date)),
  });
  return { ctx, tx, input, timeoffCompany, ...target, timezone, today, currentYear, plan, warnings: [...plan.warnings], conflicts: [...plan.conflicts], audit: [] };
}

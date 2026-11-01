import { and, asc, between, eq } from "drizzle-orm";
import { companies, holidays } from "@/db/schema";
import type { Executor } from "@/db/types";

const settingsFields = {
  timezone: companies.timezone,
  workingDays: companies.workingDays,
  allowancePolicy: companies.allowancePolicy,
};

export async function findCompanySettings(ex: Executor, companyId: string) {
  const [row] = await ex.select(settingsFields).from(companies).where(eq(companies.id, companyId));
  return row;
}

/** Every company with its calendar settings, for jobs that run across all of them. */
export async function listCompanies(ex: Executor) {
  return ex
    .select({ id: companies.id, ...settingsFields })
    .from(companies)
    .orderBy(asc(companies.createdAt), asc(companies.id));
}

/** Company holiday dates (`YYYY-MM-DD`) from `from` to `to`, inclusive. */
export async function listHolidayDates(ex: Executor, companyId: string, from: string, to: string) {
  const rows = await ex
    .select({ date: holidays.date })
    .from(holidays)
    .where(and(eq(holidays.companyId, companyId), between(holidays.date, from, to)));
  return rows.map((r) => r.date);
}

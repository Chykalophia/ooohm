import { and, between, eq } from "drizzle-orm";
import { companies, holidays } from "@/db/schema";
import type { Executor } from "@/db/types";

export async function findCompanySettings(ex: Executor, companyId: string) {
  const [row] = await ex
    .select({ timezone: companies.timezone, workingDays: companies.workingDays })
    .from(companies)
    .where(eq(companies.id, companyId));
  return row;
}

/** Company holiday dates (`YYYY-MM-DD`) from `from` to `to`, inclusive. */
export async function listHolidayDates(ex: Executor, companyId: string, from: string, to: string) {
  const rows = await ex
    .select({ date: holidays.date })
    .from(holidays)
    .where(and(eq(holidays.companyId, companyId), between(holidays.date, from, to)));
  return rows.map((r) => r.date);
}

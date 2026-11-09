import { and, asc, between, eq, inArray } from "drizzle-orm";
import { holidays } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

export type HolidayRow = { id: string; date: string; name: string };

const fields = { id: holidays.id, date: holidays.date, name: holidays.name };

/** The company's holidays from `from` to `to` inclusive, by date, with their ids. */
export async function listHolidayRows(ex: Executor, companyId: string, from: string, to: string): Promise<HolidayRow[]> {
  return ex
    .select(fields)
    .from(holidays)
    .where(and(eq(holidays.companyId, companyId), between(holidays.date, from, to)))
    .orderBy(asc(holidays.date));
}

/** The company's holidays among `ids`, by date; ids of other companies are left out. */
export async function findHolidays(ex: Executor, companyId: string, ids: readonly string[]): Promise<HolidayRow[]> {
  if (ids.length === 0) return [];
  return ex
    .select(fields)
    .from(holidays)
    .where(and(eq(holidays.companyId, companyId), inArray(holidays.id, [...ids])))
    .orderBy(asc(holidays.date));
}

/**
 * Inserts holidays on dates the company has none yet; a date already taken is skipped
 * (`holidays_company_date_uq`).
 *
 * @returns Only the rows this call created.
 */
export async function insertHolidays(
  tx: Transaction,
  companyId: string,
  rows: readonly { date: string; name: string }[],
): Promise<HolidayRow[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(holidays)
    .values(rows.map((r) => ({ companyId, ...r })))
    .onConflictDoNothing({ target: [holidays.companyId, holidays.date] })
    .returning(fields);
}

/** @returns The renamed rows, by date. */
export async function renameHolidays(tx: Transaction, companyId: string, ids: readonly string[], name: string): Promise<HolidayRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .update(holidays)
    .set({ name })
    .where(and(eq(holidays.companyId, companyId), inArray(holidays.id, [...ids])))
    .returning(fields);
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** @returns The deleted rows, by date. */
export async function deleteHolidays(tx: Transaction, companyId: string, ids: readonly string[]): Promise<HolidayRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .delete(holidays)
    .where(and(eq(holidays.companyId, companyId), inArray(holidays.id, [...ids])))
    .returning(fields);
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

import { and, asc, between, eq } from "drizzle-orm";
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

export async function findHoliday(ex: Executor, companyId: string, id: string): Promise<HolidayRow | undefined> {
  const [row] = await ex
    .select(fields)
    .from(holidays)
    .where(and(eq(holidays.id, id), eq(holidays.companyId, companyId)));
  return row;
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

export async function renameHoliday(tx: Transaction, companyId: string, id: string, name: string): Promise<HolidayRow | undefined> {
  const [row] = await tx
    .update(holidays)
    .set({ name })
    .where(and(eq(holidays.id, id), eq(holidays.companyId, companyId)))
    .returning(fields);
  return row;
}

export async function deleteHoliday(tx: Transaction, companyId: string, id: string): Promise<HolidayRow | undefined> {
  const [row] = await tx
    .delete(holidays)
    .where(and(eq(holidays.id, id), eq(holidays.companyId, companyId)))
    .returning(fields);
  return row;
}

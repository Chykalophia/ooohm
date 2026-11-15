import "server-only";
import type { Transaction } from "@/db/types";
import { insertHolidays as insertHolidayRows } from "@/modules/holidays/infrastructure/drizzle-holidays.repository";
import { type HolidayDTO, toHolidayDTO } from "@/modules/holidays/application/dto";

/**
 * Inserts holidays on dates the company has none yet, on the caller's transaction; a date
 * already taken is skipped. Writes no audit row and recounts nothing: the TimeOff import
 * records what it adds itself.
 *
 * @returns Only the holidays this call created.
 */
export async function insertHolidays(tx: Transaction, companyId: string, holidays: readonly { date: string; name: string }[]): Promise<HolidayDTO[]> {
  return (await insertHolidayRows(tx, companyId, holidays)).map(toHolidayDTO);
}

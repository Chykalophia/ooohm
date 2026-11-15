import "server-only";
import type { Executor } from "@/db/types";
import { listHolidayRows as read } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";
import { type CalendarHolidayDTO, toCalendarHolidayDTO } from "@/modules/calendar/application/dto";

/**
 * The company's holidays from `from` to `to` inclusive, by date, with their ids: the
 * holidays admin screen, the API's holiday list and the TimeOff import read them. Runs on
 * the executor it is given; the caller checks the actor.
 */
export async function listHolidayRows(ex: Executor, companyId: string, from: string, to: string): Promise<CalendarHolidayDTO[]> {
  return (await read(ex, companyId, from, to)).map(toCalendarHolidayDTO);
}

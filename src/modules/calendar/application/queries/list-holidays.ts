import "server-only";
import type { Executor } from "@/db/types";
import { listHolidays as read } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";

/**
 * Company holidays with their names from `from` to `to`, inclusive, by date: what calendars show.
 * Runs on the executor it is given; the caller checks the actor.
 */
export function listHolidays(ex: Executor, companyId: string, from: string, to: string) {
  return read(ex, companyId, from, to);
}

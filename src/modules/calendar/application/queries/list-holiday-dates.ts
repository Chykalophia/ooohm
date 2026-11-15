import "server-only";
import type { Executor } from "@/db/types";
import { listHolidayDates as read } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";

/**
 * Company holiday dates (`YYYY-MM-DD`) from `from` to `to`, inclusive: what day counting skips.
 * Runs on the executor it is given; the caller checks the actor.
 */
export function listHolidayDates(ex: Executor, companyId: string, from: string, to: string) {
  return read(ex, companyId, from, to);
}

import "server-only";
import type { Executor } from "@/db/types";
import { findCompanySettings as read } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";

/**
 * The company's calendar settings (time zone, working days, allowance policy, approval mode,
 * department scoping), or `undefined` when there is no such company.
 * Runs on the executor it is given; the caller checks the actor.
 */
export function findCompanySettings(ex: Executor, companyId: string) {
  return read(ex, companyId);
}

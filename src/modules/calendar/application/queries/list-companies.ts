import "server-only";
import type { Executor } from "@/db/types";
import { listCompanies as read } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";

/**
 * Every company with its calendar settings, for jobs that run across all of them.
 * Runs on the executor it is given; the caller checks the actor.
 */
export function listCompanies(ex: Executor) {
  return read(ex);
}

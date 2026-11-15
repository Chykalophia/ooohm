import "server-only";
import type { Executor } from "@/db/types";
import { listPersonalEntries as read } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";

/**
 * One person's pending and approved leave intersecting `[from, to]`, as calendars show it (no note).
 * Runs on the executor it is given; the caller checks the actor.
 */
export function listPersonalEntries(ex: Executor, companyId: string, userId: string, from: string, to: string) {
  return read(ex, companyId, userId, from, to);
}

import "server-only";
import type { Executor } from "@/db/types";
import { listPersonLeave as read } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";

/**
 * One person's approved and pending leave touching `from`..`to`, earliest first, with the
 * days it costs and both notes: the team member page decides which of those it shows.
 * Runs on the executor it is given; the caller checks the actor.
 */
export function listPersonLeave(ex: Executor, companyId: string, userId: string, from: string, to: string) {
  return read(ex, companyId, userId, from, to);
}

import "server-only";
import type { Executor } from "@/db/types";
import type { CalendarScope } from "@/domain/calendar-visibility";
import { listTeamEntries as read } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";

/**
 * Pending and approved leave of every active member intersecting `[from, to]`, with each
 * person's name, email (the label's fallback) and department; no note. Every caller showing
 * leave to a member passes `filter.scope` (`calendarScopeFor`); only approvers' "also off"
 * lines leave it out.
 * Runs on the executor it is given; the caller checks the actor.
 */
export function listTeamEntries(ex: Executor, companyId: string, from: string, to: string, filter: { departmentId?: string | null; scope?: CalendarScope } = {}) {
  return read(ex, companyId, from, to, filter);
}

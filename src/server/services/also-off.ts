import type { Executor } from "@/db/types";
import { entriesCostingDaysIn } from "@/domain/calendar";
import { describeOverlap, overlapsFor } from "@/domain/overlap";
import { teamLabel } from "@/domain/person";
import { canSeeOnCalendar } from "@/domain/calendar-visibility";
import { findCompanySettings, listHolidays, listTeamEntries } from "@/server/repositories/calendar";
import { loadCalendarScope } from "./calendar-scope";

/** A request an approver is about to decide, with the requester's department (if any). */
export interface AlsoOffRequest {
  id: string;
  userId: string;
  departmentId: string | null;
  departmentName: string | null;
  startDate: string;
  endDate: string;
}

/** Who else is off during a request: how many people, and the line its approver reads. */
export interface AlsoOff {
  /** Other people off then (each counted once). */
  others: number;
  line: string;
}

/**
 * Who else is off during each of `requests`, as the one line its approver reads
 * ("Nobody else in Design is off then.", "Aisha Khan is off then too.", "Also off then:
 * A, B (not approved yet) and 2 more."), by request id: people in the requester's
 * department, or everyone when they have none ({@link overlapsFor}).
 *
 * Shows only what the team calendar already shows every member: active people's
 * approved and pending leave, by name, never a note or a balance; and, as the calendar
 * does, only leave that costs a working day within the request's dates (not someone
 * whose leave there falls only on weekends or holidays, or was recounted to 0). Three
 * queries for all the requests, over the dates they span together: the leave, the
 * working days and the holidays, in parallel.
 *
 * @param readerId Who reads the line (the approver, or whoever a heads-up goes to).
 *   Under department scoping it names only people they may see (`calendarScopeFor`),
 *   for one or two more queries.
 */
export async function alsoOffFor(
  ex: Executor,
  companyId: string,
  requests: readonly AlsoOffRequest[],
  readerId?: string,
): Promise<Map<string, AlsoOff>> {
  const lines = new Map<string, AlsoOff>();
  if (requests.length === 0) return lines;
  const from = requests.reduce((min, r) => (r.startDate < min ? r.startDate : min), requests[0].startDate);
  const to = requests.reduce((max, r) => (r.endDate > max ? r.endDate : max), requests[0].endDate);
  const [entries, settings, holidays] = await Promise.all([
    listTeamEntries(ex, companyId, from, to),
    findCompanySettings(ex, companyId),
    listHolidays(ex, companyId, from, to),
  ]);
  const workingDays = settings?.workingDays ?? [];
  // Under department scoping the line names only people its reader may see.
  const scope = settings?.departmentScoping && readerId ? await loadCalendarScope(ex, companyId, readerId) : null;
  const visible = scope ? entries.filter((e) => canSeeOnCalendar(scope, { id: e.userId, managerId: e.managerId, departmentId: e.departmentId })) : entries;
  const leave = visible.map((e) => ({ ...e, personName: teamLabel({ name: e.personName, email: e.personEmail }) }));
  for (const r of requests) {
    const costing = entriesCostingDaysIn(leave, { first: r.startDate, last: r.endDate, workingDays, holidays });
    const overlaps = overlapsFor(
      { requesterId: r.userId, departmentId: r.departmentId, startDate: r.startDate, endDate: r.endDate },
      costing,
    );
    lines.set(r.id, { others: overlaps.length, line: describeOverlap(overlaps, r.departmentName) });
  }
  return lines;
}

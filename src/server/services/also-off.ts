import type { Executor } from "@/db/types";
import { entriesCostingDaysIn } from "@/domain/calendar";
import { coverageBreach, describeCoverageBreach } from "@/domain/coverage";
import { describeOverlap, overlapsFor } from "@/domain/overlap";
import { formatShortDay } from "@/lib/format";
import { teamLabel } from "@/domain/person";
import { canSeeOnCalendar } from "@/domain/calendar-visibility";
import { findCompanySettings, listHolidays, listTeamEntries } from "@/server/repositories/calendar";
import { findDepartment, findDepartmentLimits } from "@/server/repositories/departments";
import { findPerson } from "@/server/repositories/users";
import { loadCalendarScope } from "./calendar-scope";

/** A request an approver is about to decide, with the requester's department (if any). */
export interface AlsoOffRequest {
  id: string;
  userId: string;
  departmentId: string | null;
  departmentName: string | null;
  startDate: string;
  endDate: string;
  /** `approved` when it is already booked (heads-up mode): its coverage line says so. */
  status?: string;
}

/** Who else is off during a request: how many people, and the line its approver reads. */
export interface AlsoOff {
  /** Other people off then (each counted once). */
  others: number;
  line: string;
  /**
   * When the request takes its department over its coverage limit, the warning
   * ("This would put 3 people in Design off on Tue, Mar 3. The limit is 2."), else `null`.
   */
  coverage: string | null;
}

/** The also-off line with its coverage warning first, as one emails carry it. */
export function alsoOffText(alsoOff: AlsoOff | undefined): string | null {
  if (!alsoOff) return null;
  return alsoOff.coverage ? `${alsoOff.coverage} ${alsoOff.line}` : alsoOff.line;
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
 * working days and the holidays, in parallel (and the departments' coverage limits,
 * when a requester has a department).
 *
 * The coverage warning counts everyone in the requester's department, approved and
 * pending, whoever reads it: it gives a number, never a name ({@link coverageBreach}).
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
  const departmentIds = [...new Set(requests.flatMap((r) => (r.departmentId ? [r.departmentId] : [])))];
  const [entries, settings, holidays, limits] = await Promise.all([
    listTeamEntries(ex, companyId, from, to),
    findCompanySettings(ex, companyId),
    listHolidays(ex, companyId, from, to),
    findDepartmentLimits(ex, companyId, departmentIds),
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
    const maxOff = r.departmentId ? limits.get(r.departmentId) : undefined;
    const breach =
      r.departmentId && maxOff !== undefined
        ? coverageBreach({ requesterId: r.userId, departmentId: r.departmentId, startDate: r.startDate, endDate: r.endDate, maxOff }, entries, {
            workingDays,
            holidays,
          })
        : null;
    const coverage = breach ? describeCoverageBreach(breach, r.departmentName ?? "the department", formatShortDay, r.status === "approved") : null;
    lines.set(r.id, { others: overlaps.length, line: describeOverlap(overlaps, r.departmentName), coverage });
  }
  return lines;
}

/**
 * The coverage warning for a draft of `userId`'s, for the request form's live preview:
 * the same line their approver would read ({@link alsoOffFor}), or `null` when it stays
 * within their department's limit, or they have no department or it has no limit.
 */
export async function draftCoverage(
  ex: Executor,
  companyId: string,
  userId: string,
  draft: { startDate: string; endDate?: string | null },
): Promise<string | null> {
  const person = await findPerson(ex, companyId, userId);
  const department = person?.departmentId ? await findDepartment(ex, companyId, person.departmentId) : undefined;
  if (!department || department.maxOff === null) return null;
  const request = {
    id: "draft",
    userId,
    departmentId: department.id,
    departmentName: department.name,
    startDate: draft.startDate,
    endDate: draft.endDate || draft.startDate,
  };
  return (await alsoOffFor(ex, companyId, [request])).get("draft")?.coverage ?? null;
}

/**
 * Loads whose time off someone may see (`calendarScopeFor`), for every reader that
 * shows colleagues' leave: the calendar, Who's out, a teammate's page, the team
 * calendar link and the "also off" line on approvals and emails.
 */
import type { Executor } from "@/db/types";
import type { Role } from "@/domain/actor";
import { type CalendarScope, type CalendarScopeSettings, calendarScopeFor } from "@/domain/calendar-visibility";
import { findCalendarViewer } from "@/server/repositories/calendar";
import { listManagedDepartmentIds } from "@/server/repositories/departments";

/**
 * The scope of `viewer` under `company`'s settings. Reads the departments the viewer
 * manages only when department scoping is on and they are not an admin, so a company
 * without it pays no query.
 */
export async function scopeOf(
  ex: Executor,
  companyId: string,
  viewer: { id: string; role: Role; managerId: string | null; departmentId: string | null },
  company: CalendarScopeSettings,
): Promise<CalendarScope> {
  const managedDepartmentIds =
    company.departmentScoping === true && viewer.role !== "admin" ? await listManagedDepartmentIds(ex, companyId, viewer.id) : [];
  return calendarScopeFor({ ...viewer, managedDepartmentIds }, company);
}

/**
 * The scope of the member `userId`, read fresh with the company's settings. Someone not
 * in the company (or gone) sees only themself.
 */
export async function loadCalendarScope(ex: Executor, companyId: string, userId: string): Promise<CalendarScope> {
  const row = await findCalendarViewer(ex, companyId, userId);
  if (!row?.role) return { kind: "self", viewerId: userId };
  return scopeOf(ex, companyId, { id: userId, role: row.role as Role, managerId: row.managerId, departmentId: row.departmentId }, row);
}

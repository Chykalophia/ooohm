import "server-only";
import type { Actor } from "@/domain/actor";
import { entriesCostingDaysIn, groupByPerson, monthBounds } from "@/domain/calendar";
import { todayInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { listDepartments } from "@/modules/organisation";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { listHolidays, listTeamEntries } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";
import { calendarViewer, monthNav } from "@/modules/calendar/application/calendar-viewer";
import { toTeamEntry } from "@/modules/calendar/application/dto";

/** Which slice of the team the "who's out" view shows. */
export interface TeamCalendarQuery {
  /** `YYYY-MM`; anything else means the current month. */
  month?: string;
  /** A department of the actor's company; anything else means everyone. */
  departmentId?: string;
}

async function loadTeamCalendar(ctx: ServiceContext, actor: Actor, query: TeamCalendarQuery) {
  const [{ settings, scope }, departments] = await Promise.all([calendarViewer(ctx, actor), listDepartments(ctx.db, actor.companyId)]);
  const nav = monthNav(query.month, todayInTimeZone(settings.timezone, ctx.now()));
  // Under department scoping only the viewer's departments are offered. Only one of
  // those filters; any other id falls back to everyone the viewer sees.
  const offered = scope.kind === "departments" ? departments.filter((d) => scope.departmentIds.includes(d.id)) : departments;
  const department = offered.find((d) => d.id === query.departmentId) ?? null;
  const { first, last } = monthBounds(nav.month);
  const [holidays, rows] = await Promise.all([
    listHolidays(ctx.db, actor.companyId, first, last),
    listTeamEntries(ctx.db, actor.companyId, first, last, { departmentId: department?.id ?? null, scope }),
  ]);
  // Same rule as the month grid: someone whose leave only covers this month's weekends
  // or holidays is not out this month.
  const out = entriesCostingDaysIn(rows.map(toTeamEntry), { first, last, workingDays: settings.workingDays, holidays });
  return { nav, departments: offered, department, people: groupByPerson(out) };
}

/** Who's out: the month's nav, the departments offered, the one shown, and the people out. */
export type TeamCalendarDTO = Awaited<ReturnType<typeof loadTeamCalendar>>;

/**
 * Who in the actor's company is out during a month: approved leave and pending leave
 * (marked as such) of every active member the actor may see (`calendarScopeFor`) that
 * costs at least one working day of the month, grouped by person, optionally limited to
 * one department.
 *
 * Every member may see this, so it shows who, when and which leave type, and never a
 * request's note, its decision note or anyone's balance: the entries it is built from
 * do not carry them.
 *
 * Four queries however many people or requests: the viewer with the company's
 * settings, and departments, in parallel, then the month's holidays and one range query over
 * `(company_id, start_date, end_date)` in parallel.
 *
 * Fails with `no_company` when the actor's company is missing.
 */
export async function getTeamCalendar(ctx: ServiceContext, actor: Actor, query: TeamCalendarQuery = {}): Promise<ServiceResult<TeamCalendarDTO>> {
  return attempt(() => loadTeamCalendar(ctx, actor, query));
}

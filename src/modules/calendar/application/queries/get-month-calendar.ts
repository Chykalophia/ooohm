import "server-only";
import { forTenant } from "@/shared/lib/tenant";
import type { Actor } from "@/shared/kernel/actor";
import { buildAgenda, buildMonthGrid, type CalendarViewEntry, monthGridBounds } from "@/shared/kernel/calendar";
import { CALENDAR_FILTERS, type CalendarFilter, calendarFilterLabel, calendarFiltersFor, narrowCalendarScope } from "@/shared/kernel/calendar-visibility";
import { todayInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { listActiveLeaveTypesWithAllowance } from "@/shared/lib/db/leave-type-allowances";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { listHolidays, listTeamEntries } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";
import { calendarViewer, monthNav } from "@/modules/calendar/application/calendar-viewer";
import { toTeamEntry } from "@/modules/calendar/application/dto";

async function loadMonthCalendar(ctx: ServiceContext, actor: Actor, month?: string, filter?: string) {
  const { settings, person, scope } = await calendarViewer(ctx, actor);
  const shown = narrowCalendarScope(scope, person, filter);
  const nav = monthNav(month, todayInTimeZone(settings.timezone, ctx.now()));
  const { start, end } = monthGridBounds(nav.month);
  const [holidays, rows, types] = await Promise.all([
    listHolidays(ctx.db, actor.companyId, start, end),
    listTeamEntries(ctx.db, actor.companyId, start, end, { scope: shown.scope }),
    listActiveLeaveTypesWithAllowance(ctx.db, actor.companyId),
  ]);
  const entries = rows.map((row): CalendarViewEntry => ({ ...toTeamEntry(row), isMine: row.userId === actor.id }));
  const input = { month: nav.month, today: nav.today, workingDays: settings.workingDays, holidays, entries };
  return {
    nav,
    filter: shown.filter,
    filters: calendarFiltersFor(scope),
    /** How each filter reads: under department scoping, `everyone` is "My department". */
    filterLabels: Object.fromEntries(CALENDAR_FILTERS.map((f) => [f, calendarFilterLabel(f, scope)])) as Record<CalendarFilter, string>,
    weeks: buildMonthGrid(input),
    agenda: buildAgenda(input),
    leaveTypes: types.map(({ id, name, color }) => ({ id, name, color })),
  };
}

/** The month view: its nav, filters, grid, agenda and the leave types to ask for time off with. */
export type MonthCalendarDTO = Awaited<ReturnType<typeof loadMonthCalendar>>;

/**
 * The actor's month: approved and pending leave (rejected and cancelled never show),
 * company holidays and working days, plus the active leave types, so the month can be
 * used to ask for time off. By default only the actor's own leave; `filter` adds their
 * team's or everyone's, as far as the company lets them see (`narrowCalendarScope`):
 * who, when and which leave type, never a note. Four queries whatever the month holds:
 * the viewer and company settings, then holidays, the leave and the leave types in
 * parallel; one more, for the departments the viewer manages, under department scoping.
 *
 * @param month `YYYY-MM`; anything else (or nothing) means the current month in the
 *   company's time zone.
 * @param filter `me`, `team` or `everyone`; one the actor may not use (or none) means `me`.
 * @returns `filter` as applied, and `filters`, the ones the actor may use. Fails with
 *   `no_company` when the actor's company is missing.
 */
export async function getMonthCalendar(ctx: ServiceContext, actor: Actor, month?: string, filter?: string): Promise<ServiceResult<MonthCalendarDTO>> {
  ctx = forTenant(ctx, actor.companyId);
  return attempt(() => loadMonthCalendar(ctx, actor, month, filter));
}

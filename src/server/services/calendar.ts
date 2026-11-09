import type { Actor } from "@/domain/actor";
import {
  addMonths,
  buildAgenda,
  buildMonthGrid,
  type CalendarEntry,
  type CalendarViewEntry,
  entriesCostingDaysIn,
  groupByPerson,
  isYearMonth,
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR,
  monthBounds,
  monthGridBounds,
  monthOf,
  type TeamCalendarEntry,
  type YearMonth,
} from "@/domain/calendar";
import { CALENDAR_FILTERS, type CalendarFilter, calendarFilterLabel, calendarFiltersFor, narrowCalendarScope } from "@/domain/calendar-visibility";
import { DomainError } from "@/domain/errors";
import { teamLabel } from "@/domain/person";
import { todayInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { findCalendarViewer, findCompanySettings, listHolidays, listPersonalEntries, listTeamEntries } from "@/server/repositories/calendar";
import { listDepartments } from "@/server/repositories/departments";
import { listActiveLeaveTypesWithAllowance } from "@/server/repositories/leave-types";
import { scopeOf } from "./calendar-scope";

/** Where a month view sits and where its links go. */
export interface MonthNav {
  month: YearMonth;
  /** Today in the company's time zone. */
  today: string;
  previous: YearMonth;
  next: YearMonth;
  /** The month holding today, the target of the "Today" link. */
  current: YearMonth;
}

function monthNav(requested: string | undefined, today: string): MonthNav {
  const current = monthOf(today);
  const month = requested !== undefined && isYearMonth(requested) ? requested : current;
  return { month, today, previous: addMonths(month, -1), next: addMonths(month, 1), current };
}

type TeamRow = Awaited<ReturnType<typeof listTeamEntries>>[number];

/**
 * A team row as a calendar entry, labelled by {@link teamLabel}: the name, or the
 * email's local part when the name is blank, never the full address.
 */
export function toTeamEntry({ personEmail, ...row }: TeamRow): TeamCalendarEntry {
  return { ...row, personName: teamLabel({ name: row.personName, email: personEmail }) };
}

/**
 * The scope (`calendarScopeFor`) of whoever is looking, from one query that also reads
 * the company's calendar settings.
 *
 * @throws DomainError `no_company` when the actor's company is missing.
 */
async function calendarViewer(ctx: ServiceContext, actor: Actor) {
  const viewer = await findCalendarViewer(ctx.db, actor.companyId, actor.id);
  if (!viewer) throw new DomainError("no_company");
  const person = { id: actor.id, role: actor.role, managerId: viewer.managerId, departmentId: viewer.departmentId };
  return { settings: viewer, person, scope: await scopeOf(ctx.db, actor.companyId, person, viewer) };
}

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
 * @returns `filter` as applied, and `filters`, the ones the actor may use.
 * @throws DomainError `no_company` when the actor's company is missing.
 */
export async function getMonthCalendar(ctx: ServiceContext, actor: Actor, month?: string, filter?: string) {
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

/** Where a year view sits and where its links go. */
export interface YearNav {
  year: number;
  /** Today in the company's time zone. */
  today: string;
  /** The year holding today, the target of the "This year" link. */
  current: number;
}

/**
 * The actor's own year as twelve month grids (Monday first), each with its agenda for
 * screen readers: approved and pending leave, company holidays and working days.
 * Three queries: company settings, then the year's holidays and the actor's leave in
 * parallel.
 *
 * @param year A year from {@link MIN_CALENDAR_YEAR} to {@link MAX_CALENDAR_YEAR};
 *   anything else (or nothing) means the current year in the company's time zone.
 * @throws DomainError `no_company` when the actor's company is missing.
 */
export async function getYearCalendar(ctx: ServiceContext, actor: Actor, year?: number) {
  const settings = await findCompanySettings(ctx.db, actor.companyId);
  if (!settings) throw new DomainError("no_company");
  const today = todayInTimeZone(settings.timezone, ctx.now());
  const current = Number(today.slice(0, 4));
  const shown = year !== undefined && Number.isInteger(year) && year >= MIN_CALENDAR_YEAR && year <= MAX_CALENDAR_YEAR ? year : current;
  const months = Array.from({ length: 12 }, (_, i): YearMonth => `${shown}-${String(i + 1).padStart(2, "0")}`);
  const first = monthGridBounds(months[0] as YearMonth).start;
  const last = monthGridBounds(months[11] as YearMonth).end;
  const [holidays, entries] = await Promise.all([
    listHolidays(ctx.db, actor.companyId, first, last),
    listPersonalEntries(ctx.db, actor.companyId, actor.id, first, last),
  ]);
  const nav: YearNav = { year: shown, today, current };
  return {
    nav,
    months: months.map((month) => {
      const input = { month, today, workingDays: settings.workingDays, holidays, entries: entries satisfies CalendarEntry[] };
      return { month, weeks: buildMonthGrid(input), agenda: buildAgenda(input) };
    }),
  };
}

/** Which slice of the team the "who's out" view shows. */
export interface TeamCalendarQuery {
  /** `YYYY-MM`; anything else means the current month. */
  month?: string;
  /** A department of the actor's company; anything else means everyone. */
  departmentId?: string;
}

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
 * @throws DomainError `no_company` when the actor's company is missing.
 */
export async function getTeamCalendar(ctx: ServiceContext, actor: Actor, query: TeamCalendarQuery = {}) {
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


import type { Actor } from "@/domain/actor";
import {
  addMonths,
  buildAgenda,
  buildMonthGrid,
  type CalendarEntry,
  entriesCostingDaysIn,
  groupByPerson,
  isYearMonth,
  monthBounds,
  monthGridBounds,
  monthOf,
  type TeamCalendarEntry,
  type YearMonth,
} from "@/domain/calendar";
import { DomainError } from "@/domain/errors";
import { teamLabel } from "@/domain/person";
import { todayInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import {
  findCompanySettings,
  listDepartments,
  listHolidays,
  listPersonalEntries,
  listTeamEntries,
} from "@/server/repositories/calendar";

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
 * The actor's own month: approved and pending leave (rejected and cancelled never
 * show), company holidays and working days. Three queries whatever the month holds:
 * company settings, then holidays and the actor's leave in parallel.
 *
 * @param month `YYYY-MM`; anything else (or nothing) means the current month in the
 *   company's time zone.
 * @throws DomainError `no_company` when the actor's company is missing.
 */
export async function getMonthCalendar(ctx: ServiceContext, actor: Actor, month?: string) {
  const settings = await findCompanySettings(ctx.db, actor.companyId);
  if (!settings) throw new DomainError("no_company");
  const nav = monthNav(month, todayInTimeZone(settings.timezone, ctx.now()));
  const { start, end } = monthGridBounds(nav.month);
  const [holidays, entries] = await Promise.all([
    listHolidays(ctx.db, actor.companyId, start, end),
    listPersonalEntries(ctx.db, actor.companyId, actor.id, start, end),
  ]);
  const input = { month: nav.month, today: nav.today, workingDays: settings.workingDays, holidays, entries: entries satisfies CalendarEntry[] };
  return { nav, weeks: buildMonthGrid(input), agenda: buildAgenda(input) };
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
 * (marked as such) of every active member that costs at least one working day of the
 * month, grouped by person, optionally limited to one department.
 *
 * Every member may see this, so it shows who, when and which leave type, and never a
 * request's note, its decision note or anyone's balance: the entries it is built from
 * do not carry them.
 *
 * Four queries however many people or requests: settings and departments in
 * parallel, then the month's holidays and one range query over
 * `(company_id, start_date, end_date)` in parallel.
 *
 * @throws DomainError `no_company` when the actor's company is missing.
 */
export async function getTeamCalendar(ctx: ServiceContext, actor: Actor, query: TeamCalendarQuery = {}) {
  const [settings, departments] = await Promise.all([
    findCompanySettings(ctx.db, actor.companyId),
    listDepartments(ctx.db, actor.companyId),
  ]);
  if (!settings) throw new DomainError("no_company");
  const nav = monthNav(query.month, todayInTimeZone(settings.timezone, ctx.now()));
  // Only a department of this company filters; an unknown id falls back to everyone.
  const department = departments.find((d) => d.id === query.departmentId) ?? null;
  const { first, last } = monthBounds(nav.month);
  const [holidays, rows] = await Promise.all([
    listHolidays(ctx.db, actor.companyId, first, last),
    listTeamEntries(ctx.db, actor.companyId, first, last, department?.id ?? null),
  ]);
  // Same rule as the month grid: someone whose leave only covers this month's weekends
  // or holidays is not out this month.
  const out = entriesCostingDaysIn(rows.map(toTeamEntry), { first, last, workingDays: settings.workingDays, holidays });
  return { nav, departments, department, people: groupByPerson(out) };
}


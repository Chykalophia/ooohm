import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { buildAgenda, buildMonthGrid, type CalendarEntry, MAX_CALENDAR_YEAR, MIN_CALENDAR_YEAR, monthGridBounds, type YearMonth } from "@/shared/kernel/calendar";
import { DomainError } from "@/shared/kernel/errors";
import { todayInTimeZone } from "@/lib/dates";
import type { ServiceContext } from "@/server/context";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { findCompanySettings, listHolidays, listPersonalEntries } from "@/modules/calendar/infrastructure/drizzle-calendar.repository";
import type { YearNav } from "@/modules/calendar/application/calendar-viewer";

async function loadYearCalendar(ctx: ServiceContext, actor: Actor, year?: number) {
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

/** The year view: its nav and twelve month grids with their agendas. */
export type YearCalendarDTO = Awaited<ReturnType<typeof loadYearCalendar>>;

/**
 * The actor's own year as twelve month grids (Monday first), each with its agenda for
 * screen readers: approved and pending leave, company holidays and working days.
 * Three queries: company settings, then the year's holidays and the actor's leave in
 * parallel.
 *
 * @param year A year from {@link MIN_CALENDAR_YEAR} to {@link MAX_CALENDAR_YEAR};
 *   anything else (or nothing) means the current year in the company's time zone.
 *   Fails with `no_company` when the actor's company is missing.
 */
export async function getYearCalendar(ctx: ServiceContext, actor: Actor, year?: number): Promise<ServiceResult<YearCalendarDTO>> {
  return attempt(() => loadYearCalendar(ctx, actor, year));
}

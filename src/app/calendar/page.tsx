import type { Metadata } from "next";
import { yearHasHolidays } from "@/shared/kernel/calendar";
import { isHolidayYear } from "@/shared/kernel/holidays";
import { formatMonth } from "@/lib/format";
import {
  calendarFilterItems,
  calendarFilterParamSchema,
  calendarMonthHref,
  calendarYearHref,
  getMonthCalendar,
  getYearCalendar,
  monthGridCaption,
  monthParamSchema,
  yearViewMonth,
} from "@/modules/calendar";
import { unwrap } from "@/shared/lib/result";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { MonthNav, YearNav } from "@/components/navigation/month-nav";
import { PillNav } from "@/components/navigation/pill-nav";
import { readParam, yearParamSchema } from "@/shared/lib/search-params";
import { requireMemberPage } from "@/app/_lib/page-context";
import { NoHolidaysNote, SubscribeLink, ViewSwitch } from "./calendar-links";
import { MonthGrid } from "./month-grid";
import { PhoneMonth } from "./phone-month";
import { YearGrid } from "./year-grid";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The tab names the month or year on show, so two calendar tabs can be told apart (WCAG 2.4.2). */
export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const params = await searchParams;
  if (params.view === "year") {
    const year = readParam(yearParamSchema, params.year);
    return { title: year ? `Calendar, ${year} · OOOhm` : "Calendar, year view · OOOhm" };
  }
  const month = readParam(monthParamSchema, params.month);
  return { title: month ? `Calendar, ${formatMonth(month)} · OOOhm` : "Calendar, month view · OOOhm" };
}

const HEADING_ID = "month-heading";

/**
 * The person's own calendar, as a month (whose grid also asks for time off: drag across
 * days) or as the whole year. Phones get a small month with the month as a list under
 * it ({@link PhoneMonth}). The month can also show their team's or everyone's time off,
 * as far as the company lets them see.
 */
export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="calendar" />;
  const params = await searchParams;

  if (params.view === "year") {
    const year = readParam(yearParamSchema, params.year);
    const { nav, months } = unwrap(await getYearCalendar(page.ctx, page.actor, year ? Number(year) : undefined));
    return (
      <AppPage nav={page.nav} current="calendar" title="Your calendar" action={<ViewSwitch view="year" month={yearViewMonth(nav)} year={nav.year} />}>
        <section aria-labelledby={HEADING_ID} className="space-y-4">
          <YearNav nav={nav} href={calendarYearHref} headingId={HEADING_ID} />
          {!yearHasHolidays(months) && isHolidayYear(nav.year) && <NoHolidaysNote year={nav.year} admin={page.nav.admin} />}
          <YearGrid months={months} />
        </section>
        <SubscribeLink />
      </AppPage>
    );
  }

  const month = readParam(monthParamSchema, params.month);
  const { nav, weeks, agenda, leaveTypes, filter, filters, filterLabels } = unwrap(
    await getMonthCalendar(page.ctx, page.actor, month, readParam(calendarFilterParamSchema, params.show)),
  );

  return (
    <AppPage
      nav={page.nav}
      current="calendar"
      title="Your calendar"
      action={<ViewSwitch view="month" month={nav.month} year={Number(nav.month.slice(0, 4))} />}
    >
      <section aria-labelledby={HEADING_ID} className="space-y-4">
        <MonthNav nav={nav} href={(m) => calendarMonthHref(m, filter)} headingId={HEADING_ID} />

        {filters.length > 1 && <PillNav label="Whose time off" items={calendarFilterItems(nav.month, filter, filters, filterLabels)} />}

        <div className="hidden md:block">
          <MonthGrid weeks={weeks} caption={monthGridCaption(formatMonth(nav.month), filter, filterLabels)} leaveTypes={leaveTypes} />
        </div>

        <div className="md:hidden">
          <PhoneMonth month={nav.month} weeks={weeks} agenda={agenda} />
        </div>
      </section>

      <SubscribeLink />
    </AppPage>
  );
}

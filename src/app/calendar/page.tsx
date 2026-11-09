import type { Metadata } from "next";
import Link from "next/link";
import { type AgendaItem, type CalendarViewEntry, yearHasHolidays } from "@/domain/calendar";
import { CALENDAR_FILTER_LABELS, type CalendarFilter } from "@/domain/calendar-visibility";
import { isHolidayYear } from "@/domain/holidays";
import { formatLeaveDates, formatMonth } from "@/lib/format";
import { getMonthCalendar, getYearCalendar } from "@/server/services/calendar";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { StatusBadge } from "@/components/leave/status-badge";
import { MonthNav, YearNav } from "@/components/navigation/month-nav";
import { PillNav } from "@/components/navigation/pill-nav";
import { Item, ItemList } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";
import { cx, focusRing, quietLink, textLink } from "@/components/ui/styles";
import { calendarFilterParamSchema, monthParamSchema, readParam, yearParamSchema } from "@/app/_lib/calendar-input";
import { requireMemberPage } from "@/app/_lib/page-context";
import { MonthGrid } from "./month-grid";
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

/** The month view's address: `show` is left out for the default, just me. */
function monthHref(month: string, filter: CalendarFilter): string {
  const query = new URLSearchParams({ month });
  if (filter !== "me") query.set("show", filter);
  return `/calendar?${query}`;
}

function AgendaRow({ item }: { item: AgendaItem<CalendarViewEntry> }) {
  if (item.kind === "holiday") {
    return (
      <Item className="flex flex-col gap-1 text-muted">
        <span>{formatLeaveDates(item.date, item.date)}</span>
        <span className="text-sm">{item.name} · Company holiday</span>
      </Item>
    );
  }
  const { entry } = item;
  // The whole row opens the request (or, for a colleague, their page): its dates are the link, stretched over the row.
  return (
    <Item className="relative flex items-start justify-between gap-3 transition-colors hover:bg-background">
      <div className="min-w-0 space-y-1">
        <ColorLabel color={entry.leaveTypeColor} className="font-medium">
          <Link
            href={entry.isMine ? `/requests/${entry.id}` : `/team/${entry.userId}`}
            aria-label={
              entry.isMine
                ? undefined
                : `${entry.personName}, ${formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}, ${entry.leaveTypeName}: open their page`
            }
            className="outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent-ink"
          >
            {formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}
          </Link>
        </ColorLabel>
        <p className="text-sm text-muted">{entry.isMine ? entry.leaveTypeName : `${entry.personName} · ${entry.leaveTypeName}`}</p>
      </div>
      {entry.status === "pending" && <StatusBadge status="pending" />}
    </Item>
  );
}

/** Month or Year: the same calendar at two zoom levels. */
function ViewSwitch({ view, month, year }: { view: "month" | "year"; month: string; year: number }) {
  const tab = cx("rounded-full px-3 py-1 text-sm font-medium", focusRing);
  const on = cx(tab, "bg-surface text-foreground shadow-sm");
  const off = cx(tab, "text-muted hover:text-foreground");
  return (
    <nav aria-label="Calendar view" className="inline-flex rounded-full border border-border bg-background p-0.5">
      <Link href={`/calendar?month=${month}`} aria-current={view === "month" ? "page" : undefined} className={view === "month" ? on : off}>
        Month
      </Link>
      <Link
        href={`/calendar?view=year&year=${year}`}
        aria-current={view === "year" ? "page" : undefined}
        className={view === "year" ? on : off}
      >
        Year
      </Link>
    </nav>
  );
}

/**
 * The person's own calendar, as a month (whose grid also asks for time off: drag across
 * days) or as the whole year. Phones get the month as an agenda. The month can also
 * show their team's or everyone's time off, as far as the company lets them see.
 */
export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="calendar" />;
  const params = await searchParams;

  if (params.view === "year") {
    const year = readParam(yearParamSchema, params.year);
    const { nav, months } = await getYearCalendar(page.ctx, page.actor, year ? Number(year) : undefined);
    const thisMonth = nav.year === nav.current ? nav.today.slice(0, 7) : `${nav.year}-01`;
    return (
      <AppPage
        nav={page.nav}
        current="calendar"
        title="Your calendar"
        action={<ViewSwitch view="year" month={thisMonth} year={nav.year} />}
      >
        <section aria-labelledby={HEADING_ID} className="space-y-4">
          <YearNav nav={nav} href={(y) => `/calendar?view=year&year=${y}`} headingId={HEADING_ID} />
          {!yearHasHolidays(months) && <NoHolidaysNote year={nav.year} admin={page.nav.admin} />}
          <YearGrid months={months} />
        </section>
        <SubscribeLink />
      </AppPage>
    );
  }

  const month = readParam(monthParamSchema, params.month);
  const { nav, weeks, agenda, leaveTypes, filter, filters } = await getMonthCalendar(
    page.ctx,
    page.actor,
    month,
    readParam(calendarFilterParamSchema, params.show),
  );
  const whose = filter === "me" ? "Your time off" : filter === "team" ? "Your team's time off" : "Everyone's time off";

  return (
    <AppPage
      nav={page.nav}
      current="calendar"
      title="Your calendar"
      action={<ViewSwitch view="month" month={nav.month} year={Number(nav.month.slice(0, 4))} />}
    >
      <section aria-labelledby={HEADING_ID} className="space-y-4">
        <MonthNav nav={nav} href={(m) => monthHref(m, filter)} headingId={HEADING_ID} />

        {filters.length > 1 && (
          <PillNav
            label="Whose time off"
            items={filters.map((f) => ({
              href: monthHref(nav.month, f),
              label: CALENDAR_FILTER_LABELS[f],
              current: f === filter ? "page" : undefined,
            }))}
          />
        )}

        <div className="hidden md:block">
          <MonthGrid weeks={weeks} caption={`${whose} and company holidays in ${formatMonth(nav.month)}`} leaveTypes={leaveTypes} />
        </div>

        <div className="md:hidden">
          {agenda.length === 0 ? (
            <p className="text-muted">Nothing planned in {formatMonth(nav.month)}.</p>
          ) : (
            <ItemList ordered>
              {agenda.map((item) => (
                <AgendaRow key={item.kind === "leave" ? item.entry.id : `holiday-${item.date}`} item={item} />
              ))}
            </ItemList>
          )}
        </div>
      </section>

      <SubscribeLink />
    </AppPage>
  );
}

/**
 * Holidays are added a year at a time (Admin → Holidays), so a year nobody has filled in
 * yet shows none. Says so, rather than leaving people to think they were lost.
 */
function NoHolidaysNote({ year, admin }: { year: number; admin: boolean }) {
  return (
    <p className="text-sm text-muted">
      No company holidays have been added for {year} yet.{" "}
      {/* Admin → Holidays only opens 2000 to 2100; another year would land on this one. */}
      {admin && isHolidayYear(year) ? (
        <Link href={`/admin/holidays?year=${year}`} className={cx(textLink, "font-medium text-accent-ink")}>
          Add {year}&apos;s holidays
        </Link>
      ) : (
        "An admin adds them in Admin, Holidays."
      )}
    </p>
  );
}

function SubscribeLink() {
  return (
    <p className="text-sm">
      <Link href="/calendar/subscriptions" className={quietLink}>
        Add your time off to Google Calendar, Apple Calendar or Outlook
      </Link>
    </p>
  );
}

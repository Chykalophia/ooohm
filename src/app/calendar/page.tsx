import { canAdminister } from "@/domain/admin-permissions";
import type { Metadata } from "next";
import Link from "next/link";
import { type AgendaItem, MAX_CALENDAR_YEAR, MIN_CALENDAR_YEAR } from "@/domain/calendar";
import { requireActor } from "@/lib/auth";
import { formatLeaveDates, formatMonth } from "@/lib/format";
import { normalizeHexColor } from "@/lib/color";
import { serviceContext } from "@/server/runtime";
import { getApprovalNav } from "@/server/services/approvals";
import { getMonthCalendar, getYearCalendar } from "@/server/services/calendar";
import { AppHeader } from "@/app/app-header";
import { monthParamSchema, readParam, yearParamSchema } from "@/app/calendar-input";
import { MonthNav } from "@/app/month-nav";
import { NoCompany } from "@/app/no-company";
import { StatusBadge } from "@/app/status-badge";
import { MonthGrid } from "./month-grid";
import { YearGrid } from "./year-grid";

export const metadata: Metadata = { title: "Calendar · OOOhm" };

const HEADING_ID = "month-heading";

function AgendaRow({ item }: { item: AgendaItem }) {
  if (item.kind === "holiday") {
    return (
      <li className="flex flex-col gap-1 p-4 text-muted">
        <span>{formatLeaveDates(item.date, item.date)}</span>
        <span className="text-sm">{item.name} · Company holiday</span>
      </li>
    );
  }
  const { entry } = item;
  return (
    <li className="flex items-start justify-between gap-3 p-4">
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-2 font-medium">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: normalizeHexColor(entry.leaveTypeColor) }} aria-hidden />
          {formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}
        </p>
        <p className="text-sm text-muted">{entry.leaveTypeName}</p>
      </div>
      {entry.status === "pending" && <StatusBadge status="pending" />}
    </li>
  );
}

const navLink =
  "inline-flex h-9 min-w-9 items-center justify-center rounded-full px-3 text-sm text-muted hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink";

/** Month or Year: the same calendar at two zoom levels. */
function ViewSwitch({ view, month, year }: { view: "month" | "year"; month: string; year: number }) {
  const tab = "rounded-full px-3 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink";
  const on = `${tab} bg-surface text-foreground shadow-sm`;
  const off = `${tab} text-muted hover:text-foreground`;
  return (
    <nav aria-label="Calendar view" className="inline-flex rounded-full border border-border bg-background p-0.5">
      <Link href={`/calendar?month=${month}`} aria-current={view === "month" ? "page" : undefined} className={view === "month" ? on : off}>
        Month
      </Link>
      <Link href={`/calendar?view=year&year=${year}`} aria-current={view === "year" ? "page" : undefined} className={view === "year" ? on : off}>
        Year
      </Link>
    </nav>
  );
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, actor } = await requireActor();
  const userName = user.name || user.email;
  if (!actor) return <NoCompany userName={userName} current="calendar" />;

  const params = await searchParams;
  const ctx = serviceContext();

  if (params.view === "year") {
    const year = readParam(yearParamSchema, params.year);
    const [calendar, approvals] = await Promise.all([getYearCalendar(ctx, actor, year ? Number(year) : undefined), getApprovalNav(ctx, actor)]);
    const { nav, months } = calendar;
    const thisMonth = nav.year === nav.current ? nav.today.slice(0, 7) : `${nav.year}-01`;
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
        <AppHeader userName={userName} approvals={approvals} current="calendar" admin={canAdminister(actor)} />
        <main className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Your calendar</h1>
            <ViewSwitch view="year" month={thisMonth} year={nav.year} />
          </div>
          <section aria-labelledby={HEADING_ID} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id={HEADING_ID} className="text-lg font-semibold tracking-tight tabular-nums">
                {nav.year}
              </h2>
              <nav aria-label="Years" className="flex items-center gap-1">
                {nav.year > MIN_CALENDAR_YEAR && (
                  <Link href={`/calendar?view=year&year=${nav.year - 1}`} className={navLink} aria-label={`Previous year, ${nav.year - 1}`}>
                    <span aria-hidden>←</span>
                  </Link>
                )}
                <Link href={`/calendar?view=year&year=${nav.current}`} className={navLink}>
                  This year
                </Link>
                {nav.year < MAX_CALENDAR_YEAR && (
                  <Link href={`/calendar?view=year&year=${nav.year + 1}`} className={navLink} aria-label={`Next year, ${nav.year + 1}`}>
                    <span aria-hidden>→</span>
                  </Link>
                )}
              </nav>
            </div>
            <YearGrid months={months} />
          </section>
          <SubscribeLink />
        </main>
      </div>
    );
  }

  const month = readParam(monthParamSchema, params.month);
  const [calendar, approvals] = await Promise.all([getMonthCalendar(ctx, actor, month), getApprovalNav(ctx, actor)]);
  const { nav, weeks, agenda, leaveTypes } = calendar;

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <AppHeader userName={userName} approvals={approvals} current="calendar" admin={canAdminister(actor)} />

      <main className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Your calendar</h1>
          <ViewSwitch view="month" month={nav.month} year={Number(nav.month.slice(0, 4))} />
        </div>
        <section aria-labelledby={HEADING_ID} className="space-y-4">
          <MonthNav nav={nav} href={(m) => `/calendar?month=${m}`} headingId={HEADING_ID} />

          <div className="hidden md:block">
            <MonthGrid weeks={weeks} caption={`Your time off and company holidays in ${formatMonth(nav.month)}`} leaveTypes={leaveTypes} />
          </div>

          <div className="md:hidden">
            {agenda.length === 0 ? (
              <p className="text-muted">Nothing planned in {formatMonth(nav.month)}.</p>
            ) : (
              <ol className="divide-y divide-border rounded-2xl border border-border bg-surface">
                {agenda.map((item) => (
                  <AgendaRow key={item.kind === "leave" ? item.entry.id : `holiday-${item.date}`} item={item} />
                ))}
              </ol>
            )}
          </div>
        </section>

        <SubscribeLink />
      </main>
    </div>
  );
}

function SubscribeLink() {
  return (
    <p className="text-sm text-muted">
      <Link
        href="/calendar/subscriptions"
        className="rounded-md underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"
      >
        Add your time off to Google Calendar, Apple Calendar or Outlook
      </Link>
    </p>
  );
}

import { canAdminister } from "@/domain/admin-permissions";
import type { Metadata } from "next";
import Link from "next/link";
import type { AgendaItem, CalendarDay } from "@/domain/calendar";
import { requireActor } from "@/lib/auth";
import { formatLeaveDates, formatLongDate, formatMonth } from "@/lib/format";
import { normalizeHexColor } from "@/lib/color";
import { serviceContext } from "@/server/runtime";
import { getApprovalNav } from "@/server/services/approvals";
import { getMonthCalendar } from "@/server/services/calendar";
import { AppHeader } from "@/app/app-header";
import { monthParamSchema, readParam } from "@/app/calendar-input";
import { LeaveChip } from "@/app/leave-chip";
import { MonthNav } from "@/app/month-nav";
import { NoCompany } from "@/app/no-company";
import { StatusBadge } from "@/app/status-badge";

export const metadata: Metadata = { title: "Calendar · OOOhm" };

const WEEKDAYS = [
  ["Mon", "Monday"],
  ["Tue", "Tuesday"],
  ["Wed", "Wednesday"],
  ["Thu", "Thursday"],
  ["Fri", "Friday"],
  ["Sat", "Saturday"],
  ["Sun", "Sunday"],
] as const;

const HEADING_ID = "month-heading";

/** Faint diagonal hatching over the page background: a day that cannot cost leave. */
const OFF_DAY = "bg-background bg-[repeating-linear-gradient(135deg,var(--color-border)_0_1px,transparent_1px_7px)]";

/**
 * This month's working days are plain white, its weekends and holidays are hatched,
 * and the neighbouring months' days have no fill and a faded number, so the three
 * never look alike.
 */
function dayStyle(day: CalendarDay): { cell: string; number: string } {
  if (!day.inMonth) return { cell: "bg-transparent", number: "text-muted" };
  if (!day.isWorkingDay || day.holiday !== null) return { cell: OFF_DAY, number: "text-muted" };
  return { cell: "bg-surface", number: "text-foreground" };
}

function DayCell({ day }: { day: CalendarDay }) {
  const style = dayStyle(day);
  return (
    <td className={`h-24 border border-border p-1.5 align-top ${style.cell}`}>
      <div className="flex flex-col gap-1">
        <span
          aria-hidden
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums ${
            day.isToday ? "bg-accent font-semibold text-accent-foreground" : style.number
          }`}
        >
          {Number(day.date.slice(8))}
        </span>
        <span className="sr-only">
          {formatLongDate(day.date)}
          {day.isToday && ", today"}
          {!day.isWorkingDay && ", not a working day"}
        </span>
        {day.holiday && (
          <span className="truncate text-xs text-muted" title={day.holiday}>
            {day.holiday}
            <span className="sr-only">, company holiday</span>
          </span>
        )}
        {day.entries.length > 0 && (
          <ul className="space-y-1">
            {day.entries.map((entry) => (
              <li key={entry.id}>
                <LeaveChip entry={entry} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </td>
  );
}

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
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: normalizeHexColor(entry.leaveTypeColor) }}
            aria-hidden
          />
          {formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}
        </p>
        <p className="text-sm text-muted">{entry.leaveTypeName}</p>
      </div>
      {entry.status === "pending" && <StatusBadge status="pending" />}
    </li>
  );
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, actor } = await requireActor();
  const userName = user.name || user.email;
  if (!actor) return <NoCompany userName={userName} current="calendar" />;

  const month = readParam(monthParamSchema, (await searchParams).month);
  const ctx = serviceContext();
  const [calendar, approvals] = await Promise.all([getMonthCalendar(ctx, actor, month), getApprovalNav(ctx, actor)]);
  const { nav, weeks, agenda } = calendar;

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <AppHeader userName={userName} approvals={approvals} current="calendar" admin={canAdminister(actor)} />

      <main className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Your calendar</h1>
        <section aria-labelledby={HEADING_ID} className="space-y-4">
          <MonthNav nav={nav} href={(m) => `/calendar?month=${m}`} headingId={HEADING_ID} />

          <table className="hidden w-full table-fixed border-collapse md:table">
            <caption className="sr-only">Your time off and company holidays in {formatMonth(nav.month)}</caption>
            <thead>
              <tr>
                {WEEKDAYS.map(([short, long]) => (
                  <th key={short} scope="col" className="pb-2 text-left text-xs font-medium text-muted">
                    <abbr title={long} className="no-underline">
                      {short}
                    </abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week[0].date}>
                  {week.map((day) => (
                    <DayCell key={day.date} day={day} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

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

        <p className="text-sm text-muted">
          <Link
            href="/calendar/subscriptions"
            className="rounded-md underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"
          >
            Add your time off to Google Calendar, Apple Calendar or Outlook
          </Link>
        </p>
      </main>
    </div>
  );
}

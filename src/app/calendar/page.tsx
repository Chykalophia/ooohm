import type { Metadata } from "next";
import Link from "next/link";
import type { AgendaItem, CalendarDay } from "@/domain/calendar";
import { formatLeaveDates, formatLongDate, formatMonth, WEEKDAY_NAMES } from "@/lib/format";
import { getMonthCalendar } from "@/server/services/calendar";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { LeaveChip } from "@/components/leave/leave-chip";
import { StatusBadge } from "@/components/leave/status-badge";
import { MonthNav } from "@/components/navigation/month-nav";
import { Item, ItemList } from "@/components/ui/card";
import { ColorLabel } from "@/components/ui/color-label";
import { quietLink } from "@/components/ui/styles";
import { monthParamSchema, readParam } from "@/app/_lib/calendar-input";
import { requireMemberPage } from "@/app/_lib/page-context";

export const metadata: Metadata = { title: "Calendar · OOOhm" };

const HEADING_ID = "month-heading";

/** Faint diagonal hatching over the page background: a day that cannot cost leave. */
const OFF_DAY = "bg-background bg-[repeating-linear-gradient(135deg,var(--color-border)_0_1px,transparent_1px_7px)]";

/**
 * This month's working days are plain white, its weekends and holidays are hatched,
 * and the neighbouring months' days have no fill and a faded number, so the three
 * never look alike.
 */
function dayStyle(day: CalendarDay): { cell: string; number: string } {
  if (!day.inMonth) return { cell: "bg-transparent", number: "text-muted opacity-60" };
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
      <Item className="flex flex-col gap-1 text-muted">
        <span>{formatLeaveDates(item.date, item.date)}</span>
        <span className="text-sm">{item.name} · Company holiday</span>
      </Item>
    );
  }
  const { entry } = item;
  return (
    <Item className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <ColorLabel color={entry.leaveTypeColor} className="font-medium">
          {formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}
        </ColorLabel>
        <p className="text-sm text-muted">{entry.leaveTypeName}</p>
      </div>
      {entry.status === "pending" && <StatusBadge status="pending" />}
    </Item>
  );
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="calendar" />;

  const month = readParam(monthParamSchema, (await searchParams).month);
  const { nav, weeks, agenda } = await getMonthCalendar(page.ctx, page.actor, month);

  return (
    <AppPage nav={page.nav} current="calendar" title="Your calendar">
      <section aria-labelledby={HEADING_ID} className="space-y-4">
        <MonthNav nav={nav} href={(m) => `/calendar?month=${m}`} headingId={HEADING_ID} />

        <table className="hidden w-full table-fixed border-collapse md:table">
          <caption className="sr-only">Your time off and company holidays in {formatMonth(nav.month)}</caption>
          <thead>
            <tr>
              {WEEKDAY_NAMES.map((name) => (
                <th key={name} scope="col" className="pb-2 text-left text-xs font-medium text-muted">
                  <abbr title={name} className="no-underline">
                    {name.slice(0, 3)}
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
            <ItemList ordered>
              {agenda.map((item) => (
                <AgendaRow key={item.kind === "leave" ? item.entry.id : `holiday-${item.date}`} item={item} />
              ))}
            </ItemList>
          )}
        </div>
      </section>

      <p className="text-sm">
        <Link href="/calendar/subscriptions" className={quietLink}>
          Add your time off to Google Calendar, Apple Calendar or Outlook
        </Link>
      </p>
    </AppPage>
  );
}

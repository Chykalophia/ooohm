import Link from "next/link";
import type { AgendaItem, CalendarDay, YearMonth } from "@/domain/calendar";
import { formatLeaveDates, formatMonth } from "@/lib/format";
import { cx, focusRing } from "@/components/ui/styles";
import { MiniLegend, miniDay, WEEKDAY_INITIALS } from "./mini-day";

function AgendaText({ item }: { item: AgendaItem }) {
  if (item.kind === "holiday") return <>{`${formatLeaveDates(item.date, item.date)}: ${item.name}, company holiday`}</>;
  const { entry } = item;
  return (
    <>{`${formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}: ${entry.leaveTypeName}${entry.status === "pending" ? ", waiting for approval" : ""}`}</>
  );
}

/** The year's squares: small, in a grid of twelve months. */
const MINI = "rounded-[4px] text-[11px]";

/**
 * The whole year as twelve small months. The squares are for the eye only; each
 * month's heading links to its month view, and a screen reader hears that month's
 * leave and holidays as a list instead.
 */
export function YearGrid({ months }: { months: { month: YearMonth; weeks: CalendarDay[][]; agenda: AgendaItem[] }[] }) {
  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 md:grid-cols-4">
        {months.map(({ month, weeks, agenda }) => (
          <li key={month} className="space-y-1.5">
            <h3 className="text-sm font-semibold">
              <Link href={`/calendar?month=${month}`} className={cx("rounded-md hover:text-accent-ink", focusRing)}>
                {formatMonth(month).split(" ")[0]}
              </Link>
            </h3>
            <div aria-hidden className="grid grid-cols-7 gap-0.5">
              {WEEKDAY_INITIALS.map((d, i) => (
                <span key={i} className="text-center text-[10px] text-muted">
                  {d}
                </span>
              ))}
              {weeks.flat().map((day) => {
                const { className, style, swatch } = miniDay(day, MINI);
                return (
                  <span key={day.date} className={className} style={style} data-swatch={swatch ? "" : undefined}>
                    {Number(day.date.slice(8))}
                  </span>
                );
              })}
            </div>
            <div className="sr-only">
              {agenda.length === 0 ? (
                <p>Nothing planned.</p>
              ) : (
                <ul>
                  {agenda.map((item) => (
                    <li key={item.kind === "leave" ? item.entry.id : `holiday-${item.date}`}>
                      <AgendaText item={item} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>
      <MiniLegend />
    </div>
  );
}

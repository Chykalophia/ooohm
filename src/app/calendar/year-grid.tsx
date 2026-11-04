import Link from "next/link";
import type { AgendaItem, CalendarDay, YearMonth } from "@/domain/calendar";
import { normalizeHexColor, readableTextColor } from "@/lib/color";
import { formatLeaveDates, formatMonth } from "@/lib/format";
import { cx, focusRing } from "@/components/ui/styles";

const INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * How a day looks in the year: approved leave filled in its type's colour, pending
 * leave outlined in it, company holidays outlined in ink, today filled in ink, and
 * days that never cost leave faded. Leave wins over a holiday; today on leave keeps
 * the leave's look with an ink ring around it. Neighbouring months' days are left blank.
 *
 * In forced colours, which drop fills and rings: an approved day keeps its leave colour
 * (`swatch`: the colour is the point) with today's ring in the system text colour; a
 * waiting day gets a dashed border, a holiday a solid one, and today a thick one.
 */
function miniDay(day: CalendarDay): { className: string; style?: React.CSSProperties; swatch?: boolean } {
  const base = "flex aspect-square items-center justify-center rounded-[4px] text-[11px] tabular-nums";
  if (!day.inMonth) return { className: `${base} invisible` };
  const entry = day.entries.find((e) => e.status === "approved") ?? day.entries[0];
  if (entry) {
    const color = normalizeHexColor(entry.leaveTypeColor);
    const today = day.isToday ? " outline-2 outline-offset-1 outline-foreground forced-colors:outline-[CanvasText]" : "";
    return entry.status === "approved"
      ? { className: `${base} font-medium${today}`, style: { backgroundColor: color, color: readableTextColor(color) }, swatch: true }
      : {
          className: `${base} font-medium text-foreground forced-colors:border forced-colors:border-dashed${today}`,
          style: { boxShadow: `inset 0 0 0 1.5px ${color}` },
        };
  }
  if (day.isToday) return { className: `${base} bg-foreground font-semibold text-background forced-colors:border-2` };
  if (day.holiday) return { className: `${base} text-foreground ring-1 ring-foreground/60 ring-inset forced-colors:border` };
  // Working days in ink, days off in grey: both keep text contrast (no opacity).
  if (!day.isWorkingDay) return { className: `${base} text-muted` };
  return { className: `${base} text-foreground` };
}

function AgendaText({ item }: { item: AgendaItem }) {
  if (item.kind === "holiday") return <>{`${formatLeaveDates(item.date, item.date)}: ${item.name}, company holiday`}</>;
  const { entry } = item;
  return (
    <>{`${formatLeaveDates(entry.startDate, entry.endDate, entry.dayPortion)}: ${entry.leaveTypeName}${entry.status === "pending" ? ", waiting for approval" : ""}`}</>
  );
}

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
              {INITIALS.map((d, i) => (
                <span key={i} className="text-center text-[10px] text-muted">
                  {d}
                </span>
              ))}
              {weeks.flat().map((day) => {
                const { className, style, swatch } = miniDay(day);
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
      <ul aria-hidden className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] bg-foreground forced-colors:border-2" /> Today
        </li>
        <li className="flex items-center gap-1.5">
          <span data-swatch className="h-3 w-3 rounded-[3px] bg-accent" /> Time off, in its type’s colour
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] ring-[1.5px] ring-accent ring-inset forced-colors:border forced-colors:border-dashed" /> Waiting for approval, outlined in its type’s colour
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] ring-1 ring-foreground/60 ring-inset forced-colors:border" /> Company holiday
        </li>
      </ul>
    </div>
  );
}

"use client";

import { useState } from "react";
import { type AgendaItem, agendaForDay, type CalendarDay, type CalendarViewEntry, type YearMonth } from "@/domain/calendar";
import { formatLongDate, formatMonth } from "@/lib/format";
import { ItemList } from "@/components/ui/card";
import { cx, subtleButton } from "@/components/ui/styles";
import { AgendaRow } from "./agenda-row";
import { dayLabel } from "./month-grid";
import { MiniLegend, miniDay, WEEKDAY_INITIALS } from "./mini-day";

/** The phone's squares: big enough to tap (about 44px across on a 375px screen). */
const PHONE = "rounded-md text-sm";

/**
 * The month on a phone, where a grid of day boxes doesn't fit: a small month to see it
 * at a glance (as in the year view), with the month as a list under it. Tapping a day
 * narrows the list to that day; tapping it again, or "Whole month", brings the month back.
 */
export function PhoneMonth({
  month,
  weeks,
  agenda,
}: {
  month: YearMonth;
  weeks: CalendarDay<CalendarViewEntry>[][];
  agenda: AgendaItem<CalendarViewEntry>[];
}) {
  const days = weeks.flat();
  const [picked, setPicked] = useState<string | null>(null);
  // After moving to another month the old day is gone, so the whole month shows.
  const day = days.find((d) => d.date === picked && d.inMonth) ?? null;
  const items = day ? agendaForDay(agenda, day) : agenda;

  return (
    <div className="space-y-4">
      <div role="group" aria-label={`Days in ${formatMonth(month)}`} className="space-y-2">
        <div className="grid grid-cols-7 gap-1">
          {WEEKDAY_INITIALS.map((d, i) => (
            <span key={i} aria-hidden className="text-center text-xs text-muted">
              {d}
            </span>
          ))}
          {days.map((d) => {
            const { className, style, swatch } = miniDay(d, PHONE);
            if (!d.inMonth) return <span key={d.date} aria-hidden className={className} />;
            const selected = d.date === day?.date;
            return (
              <button
                key={d.date}
                type="button"
                aria-label={dayLabel(d)}
                aria-pressed={selected}
                onClick={() => setPicked(selected ? null : d.date)}
                className={cx(
                  className,
                  "w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink",
                  selected && "outline-2 outline-offset-2 outline-accent-ink forced-colors:outline-[Highlight]",
                )}
                style={style}
                data-swatch={swatch ? "" : undefined}
              >
                {Number(d.date.slice(8))}
              </button>
            );
          })}
        </div>
        <MiniLegend />
      </div>

      <div aria-live="polite" className="flex min-h-6 items-baseline justify-between gap-3">
        <p className="font-medium">{day ? formatLongDate(day.date) : `All of ${formatMonth(month)}`}</p>
        {day && (
          <button type="button" onClick={() => setPicked(null)} className={subtleButton}>
            Whole month
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-muted">{day ? "Nothing on this day." : `Nothing planned in ${formatMonth(month)}.`}</p>
      ) : (
        <ItemList ordered>
          {items.map((item) => (
            <AgendaRow key={item.kind === "leave" ? item.entry.id : `holiday-${item.date}`} item={item} />
          ))}
        </ItemList>
      )}
    </div>
  );
}

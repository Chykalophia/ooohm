import type { CSSProperties } from "react";
import type { CalendarDay } from "@/domain/calendar";
import { normalizeHexColor, readableTextColor } from "@/lib/color";

/** Monday first, as every month grid is. */
export const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * How a day looks in a small month (the year view, and the month on phones): approved
 * leave filled in its type's colour, pending leave outlined in it, company holidays outlined in ink, today filled in ink, and
 * days that never cost leave faded. Leave wins over a holiday; today on leave keeps
 * the leave's look with an ink ring around it. Neighbouring months' days are left blank.
 * `size` is the square's corner and type size.
 *
 * In forced colours, which drop fills and rings: an approved day keeps its leave colour
 * (`swatch`: the colour is the point) with today's ring in the system text colour; a
 * waiting day gets a dashed border, a holiday a solid one, and today a thick one.
 */
export function miniDay(day: CalendarDay, size: string): { className: string; style?: CSSProperties; swatch?: boolean } {
  const base = `flex aspect-square items-center justify-center tabular-nums ${size}`;
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

/** What the small months' squares mean; for the eye only, since screen readers hear each day in words. */
export function MiniLegend() {
  return (
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
  );
}

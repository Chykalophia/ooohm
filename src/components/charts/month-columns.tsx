import { normalizeHexColor } from "@/lib/color";
import { formatDays } from "@/lib/format";
import { ChartTooltip } from "./chart-tooltip";

/** One month's column: its stacked segments (one per leave type), and last year's total for the marker. */
export interface MonthColumn {
  /** Short label under the column, "Jan". */
  label: string;
  /** Full label for the tooltip, "January 2026". */
  title: string;
  segments: { key: string; name: string; color: string; days: number }[];
  total: number;
  /** The same month a year earlier; drawn as a thin tick across the column. */
  compare: number;
  /** Booked, not yet taken: drawn lighter. */
  ahead: boolean;
}

/**
 * Twelve stacked columns of days off, one per month, coloured by leave type, with a tick
 * at the year before's total so the two years read on one axis. Months still ahead are
 * lighter. Decorative for screen readers: the page puts the same numbers in a table.
 *
 * Hovering (or focusing) a column shows its numbers. The segments keep a 2px gap in the
 * surface colour, so neighbouring types stay apart whatever their colours.
 */
export function MonthColumns({ columns, compareLabel }: { columns: MonthColumn[]; compareLabel: string }) {
  const max = Math.max(1, ...columns.map((c) => Math.max(c.total, c.compare)));
  return (
    <div aria-hidden className="space-y-2">
      <div className="relative grid h-48 grid-cols-12 items-end gap-1.5 border-b border-border sm:gap-2.5">
        {columns.map((c) => (
          <div key={c.label} className="group relative flex h-full items-end justify-center">
            <div
              className={`flex w-full max-w-9 flex-col-reverse gap-[2px] ${c.ahead ? "opacity-55" : ""}`}
              style={{ height: `${(c.total / max) * 100}%` }}
            >
              {c.segments.map((s, i) => (
                <div
                  key={s.key}
                  className={i === c.segments.length - 1 ? "rounded-t-[4px]" : ""}
                  style={{ flexGrow: s.days, flexBasis: 0, minHeight: 2, backgroundColor: normalizeHexColor(s.color) }}
                />
              ))}
            </div>
            {c.compare > 0 && (
              <div className="pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-foreground/45" style={{ bottom: `calc(${(c.compare / max) * 100}% - 1px)` }} />
            )}
            <ChartTooltip>
              <p className="font-medium">{c.title}</p>
              {c.segments.map((s) => (
                <p key={s.key} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: normalizeHexColor(s.color) }} />
                  {s.name}: {formatDays(s.days)}
                </p>
              ))}
              <p>{c.total === 0 ? "No time off" : `${formatDays(c.total)} in all${c.ahead ? ", booked ahead" : ""}`}</p>
              <p className="text-muted">
                {compareLabel}: {formatDays(c.compare)}
              </p>
            </ChartTooltip>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-12 gap-1.5 text-center text-xs text-muted sm:gap-2.5">
        {columns.map((c) => (
          <span key={c.label}>
            <span className="sm:hidden">{c.label.slice(0, 1)}</span>
            <span className="hidden sm:inline">{c.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

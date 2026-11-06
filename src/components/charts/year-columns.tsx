import { formatDays } from "@/lib/format";
import { ChartTooltip } from "./chart-tooltip";

/**
 * Days off per year, one accent column each, every column labelled with its value (a
 * handful of years, so direct labels never crowd). The last year is the report's own and
 * full strength; earlier years are lighter. Decorative for screen readers: the page
 * states the same numbers in text.
 */
export function YearColumns({ years }: { years: { year: number; days: number }[] }) {
  const max = Math.max(1, ...years.map((y) => y.days));
  return (
    <div aria-hidden className="space-y-2">
      <div className="flex h-36 items-end gap-3 border-b border-border sm:gap-5">
        {years.map((y, i) => (
          <div key={y.year} className="group relative flex h-full flex-1 flex-col items-center justify-end gap-1">
            <span className="text-xs text-muted tabular-nums">{y.days}</span>
            <div
              className={`w-full max-w-14 rounded-t-[4px] bg-accent ${i === years.length - 1 ? "" : "opacity-45"}`}
              style={{ height: `${(y.days / max) * 80}%`, minHeight: y.days > 0 ? 2 : 0 }}
            />
            <ChartTooltip align={i === 0 ? "start" : i === years.length - 1 ? "end" : "center"}>
              <p className="font-medium">{y.year}</p>
              <p>{formatDays(y.days)} off</p>
            </ChartTooltip>
          </div>
        ))}
      </div>
      <div className="flex gap-3 text-xs text-muted sm:gap-5">
        {years.map((y) => (
          <span key={y.year} className="flex-1 text-center tabular-nums">
            {y.year}
          </span>
        ))}
      </div>
    </div>
  );
}

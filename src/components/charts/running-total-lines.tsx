import { formatDays } from "@/lib/format";
import { ChartTooltip } from "./chart-tooltip";

/** The SVG is drawn on this grid and stretched to the box; strokes keep their width. */
const W = 1200;
const H = 300;

/** A round top for the axis, a little above `n`: a multiple of half its power of ten (4 for an empty chart). */
function niceCeil(n: number): number {
  if (n <= 0) return 4;
  const unit = Math.max(1, 10 ** Math.floor(Math.log10(n)) / 2);
  return Math.ceil(n / unit) * unit;
}

const point = (values: readonly number[], max: number) => (i: number) => {
  // Point 0 is Jan 1 at zero; point i is the end of month i.
  const x = (i / 12) * W;
  const y = H - ((i === 0 ? 0 : values[i - 1]) / max) * H;
  return `${x.toFixed(1)},${y.toFixed(1)}`;
};

const path = (pts: string[]) => (pts.length < 2 ? "" : `M${pts.join("L")}`);

/**
 * Days off so far through the year, month by month: the report's year as an accent line
 * over a soft fill, the year before as a thin muted line, both from zero on Jan 1. Months
 * still ahead (booked, not yet taken) are dashed. Hovering over a month shows both
 * totals. Decorative for screen readers: the page puts the same numbers in a table.
 */
export function RunningTotalLines({
  labels,
  days,
  previous,
  takenMonths,
  label,
  compareLabel,
}: {
  /** Twelve short month labels, "Jan" first. */
  labels: string[];
  /** Approved days so far by the end of each month. */
  days: number[];
  previous: number[];
  /** How many months, from January, are behind us; the rest of the line is dashed. */
  takenMonths: number;
  label: string;
  compareLabel: string;
}) {
  const max = niceCeil(Math.max(...days, ...previous));
  const at = point(days, max);
  const prevAt = point(previous, max);
  const all = Array.from({ length: 13 }, (_, i) => i);
  const taken = Math.max(0, Math.min(12, takenMonths));
  const solid = all.slice(0, taken + 1).map(at);
  const dashed = all.slice(taken).map(at);
  const area = solid.length > 1 ? `${path(solid)}L${(taken / 12) * W},${H}L0,${H}Z` : "";
  const ticks = [max, max / 2, 0];

  return (
    <div aria-hidden className="space-y-2">
      <div className="flex gap-2">
        <div className="relative w-7 shrink-0 text-right text-xs text-muted tabular-nums">
          {ticks.map((t, i) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${(i / (ticks.length - 1)) * 100}%` }}>
              {t}
            </span>
          ))}
        </div>
        <div className="relative h-48 flex-1">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
            {ticks.map((t) => (
              <line key={t} x1={0} x2={W} y1={H - (t / max) * H} y2={H - (t / max) * H} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            {area && <path d={area} className="fill-accent opacity-15" />}
            <path d={path(all.map(prevAt))} fill="none" className="stroke-muted opacity-70" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <path
              d={path(dashed)}
              fill="none"
              className="stroke-accent opacity-60"
              strokeWidth={2.5}
              strokeDasharray="5 5"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            <path d={path(solid)} fill="none" className="stroke-accent" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {/* One hover zone per month; its dots sit on the month's end. */}
          <div className="absolute inset-0 grid grid-cols-12">
            {labels.map((month, i) => (
              <div key={month} className="group relative">
                <div className="absolute inset-y-0 right-0 hidden w-px bg-border group-hover:block" />
                <span
                  className="absolute right-0 hidden h-2.5 w-2.5 translate-x-1/2 translate-y-1/2 rounded-full border-2 border-surface bg-muted group-hover:block"
                  style={{ bottom: `${(previous[i] / max) * 100}%` }}
                />
                <span
                  className="absolute right-0 hidden h-3 w-3 translate-x-1/2 translate-y-1/2 rounded-full border-2 border-surface bg-accent group-hover:block"
                  style={{ bottom: `${(days[i] / max) * 100}%` }}
                />
                <ChartTooltip align={i < 2 ? "start" : i > labels.length - 3 ? "end" : "center"}>
                  <p className="font-medium">By the end of {month}</p>
                  <p className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-accent" />
                    {label}: {formatDays(days[i])}
                    {i >= taken ? ", with bookings" : ""}
                  </p>
                  <p className="flex items-center gap-1.5 text-muted">
                    <span className="h-2 w-2 rounded-full bg-muted" />
                    {compareLabel}: {formatDays(previous[i])}
                  </p>
                </ChartTooltip>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <div className="w-7 shrink-0" />
        <div className="grid flex-1 grid-cols-12 text-center text-xs text-muted">
          {labels.map((m) => (
            <span key={m}>
              <span className="sm:hidden">{m.slice(0, 1)}</span>
              <span className="hidden sm:inline">{m}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

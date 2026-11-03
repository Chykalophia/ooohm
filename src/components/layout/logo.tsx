import { OHM_OFFSET, OHM_PATH, OHM_SCALE, OHM_STROKE_WIDTH } from "@/lib/brand-mark";

/** The Ω mark on its accent tile, the same drawing as the favicon. Sized by the text around it. */
export function OhmMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={`h-[1.15em] w-[1.15em] shrink-0 ${className}`}>
      <rect width="32" height="32" rx="7" className="fill-accent" />
      <g transform={`translate(${OHM_OFFSET} ${OHM_OFFSET}) scale(${OHM_SCALE})`}>
        <path
          d={OHM_PATH}
          fill="none"
          className="stroke-accent-foreground"
          strokeWidth={OHM_STROKE_WIDTH}
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

/** Mark and wordmark: the "OOO" carries the meaning, the "hm" sits quietly beside it. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-[0.4em] text-xl font-semibold tracking-tight ${className}`}
      aria-label="OOOhm"
      role="img"
    >
      <OhmMark />
      <span>
        <span className="text-accent-ink">OOO</span>
        <span className="text-muted font-normal">hm</span>
      </span>
    </span>
  );
}

/**
 * The box a chart mark shows while the pointer is over it. Its parent must be a `group`
 * with `relative` positioning. Charts are hidden from screen readers (their page lists
 * the same numbers), so this is for sighted pointer users only.
 */
export function ChartTooltip({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden w-max max-w-56 -translate-x-1/2 space-y-0.5 rounded-lg border border-border bg-surface px-3 py-2 text-left text-xs shadow-sm group-hover:block">
      {children}
    </div>
  );
}

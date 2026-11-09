import { normalizeHexColor } from "@/lib/color";

/** One row of a {@link BarList}. */
export interface BarListItem {
  key: string;
  label: React.ReactNode;
  value: number;
  /** The value as read, e.g. "12 days". */
  valueLabel: string;
  /** A short second line, e.g. "3 requests". */
  detail?: string;
  /** A leave type's colour; the accent when omitted. */
  color?: string;
}

/**
 * A ranked list with a thin bar under each label, scaled to the largest value. Each
 * row's text states its value, so the bar only adds the shape: it is hidden from screen
 * readers and the list reads as plain text.
 */
export function BarList({ items, label }: { items: BarListItem[]; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul aria-label={label} className="space-y-3">
      {items.map((item) => (
        <li key={item.key} className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="min-w-0 break-words">{item.label}</span>
            <span className="shrink-0 tabular-nums">
              {item.valueLabel}
              {item.detail && <span className="text-muted"> · {item.detail}</span>}
            </span>
          </div>
          <div aria-hidden className="h-2 rounded-full bg-border/50">
            <div
              className={`h-full rounded-full ${item.color ? "" : "bg-accent"}`}
              style={{ width: `${(item.value / max) * 100}%`, backgroundColor: item.color ? normalizeHexColor(item.color) : undefined }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

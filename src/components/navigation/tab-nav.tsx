import Link from "next/link";
import { cx, focusRing } from "@/components/ui/styles";

/** One tab: where it leads, its label, an optional count shown beside it, and whether it is the current one. */
export type TabNavItem = { href: string; label: string; count?: number; current: boolean };

/**
 * A row of tabs over a list that splits one thing several ways (Approvals: Needs you,
 * Waiting on others, Settled). Plain links, so each tab has its own URL and no
 * JavaScript is needed; the current one is underlined in the accent and marked
 * `aria-current="page"`. A count shows only when it is more than 0.
 */
export function TabNav({ label, items }: { label: string; items: readonly TabNavItem[] }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border">
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.current ? "page" : undefined}
          className={cx(
            "-mb-px inline-flex min-h-6 items-center gap-2 border-b-2 pb-2 text-sm font-medium",
            t.current ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground",
            focusRing,
          )}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && (
            <span className="rounded-full bg-accent/10 px-2 text-xs text-accent-ink tabular-nums">{t.count}</span>
          )}
        </Link>
      ))}
    </nav>
  );
}

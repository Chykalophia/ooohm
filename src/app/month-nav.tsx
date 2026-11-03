import Link from "next/link";
import { formatMonth } from "@/lib/format";

const linkClass =
  "inline-flex h-9 min-w-9 items-center justify-center rounded-full px-3 text-sm text-muted hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink";

/**
 * The month's name as the page's subheading, with previous, today and next links.
 *
 * @param href Builds the link for a month, keeping the page's other filters.
 */
export function MonthNav({
  nav,
  href,
  headingId,
}: {
  nav: { month: string; previous: string; next: string; current: string };
  href: (month: string) => string;
  headingId: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id={headingId} className="text-lg font-semibold tracking-tight">
        {formatMonth(nav.month)}
      </h2>
      <nav aria-label="Months" className="flex items-center gap-1">
        <Link href={href(nav.previous)} className={linkClass} aria-label={`Previous month, ${formatMonth(nav.previous)}`}>
          <span aria-hidden>←</span>
        </Link>
        <Link href={href(nav.current)} className={linkClass}>
          Today
        </Link>
        <Link href={href(nav.next)} className={linkClass} aria-label={`Next month, ${formatMonth(nav.next)}`}>
          <span aria-hidden>→</span>
        </Link>
      </nav>
    </div>
  );
}

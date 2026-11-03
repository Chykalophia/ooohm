import Link from "next/link";
import { MAX_CALENDAR_YEAR, MIN_CALENDAR_YEAR } from "@/domain/calendar";
import { formatMonth } from "@/lib/format";
import { focusRing } from "@/components/ui/styles";

const linkClass = `inline-flex h-9 min-w-9 items-center justify-center rounded-full px-3 text-sm text-muted hover:bg-surface hover:text-foreground ${focusRing}`;

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

/**
 * The year as the page's subheading, with previous, this year and next links, as
 * {@link MonthNav} does for a month. The arrows stop at the calendar's bounds.
 */
export function YearNav({
  nav,
  href,
  headingId,
}: {
  nav: { year: number; current: number };
  href: (year: number) => string;
  headingId: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id={headingId} className="text-lg font-semibold tracking-tight tabular-nums">
        {nav.year}
      </h2>
      <nav aria-label="Years" className="flex items-center gap-1">
        {nav.year > MIN_CALENDAR_YEAR && (
          <Link href={href(nav.year - 1)} className={linkClass} aria-label={`Previous year, ${nav.year - 1}`}>
            <span aria-hidden>←</span>
          </Link>
        )}
        <Link href={href(nav.current)} className={linkClass}>
          This year
        </Link>
        {nav.year < MAX_CALENDAR_YEAR && (
          <Link href={href(nav.year + 1)} className={linkClass} aria-label={`Next year, ${nav.year + 1}`}>
            <span aria-hidden>→</span>
          </Link>
        )}
      </nav>
    </div>
  );
}

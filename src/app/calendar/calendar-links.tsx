import Link from "next/link";
import { cx, focusRing, quietLink, textLink } from "@/components/ui/styles";

/** Month or Year: the same calendar at two zoom levels. */
export function ViewSwitch({ view, month, year }: { view: "month" | "year"; month: string; year: number }) {
  const tab = cx("rounded-full px-3 py-1 text-sm font-medium", focusRing);
  const on = cx(tab, "bg-surface text-foreground shadow-sm");
  const off = cx(tab, "text-muted hover:text-foreground");
  return (
    <nav aria-label="Calendar view" className="inline-flex rounded-full border border-border bg-background p-0.5">
      <Link href={`/calendar?month=${month}`} aria-current={view === "month" ? "page" : undefined} className={view === "month" ? on : off}>
        Month
      </Link>
      <Link
        href={`/calendar?view=year&year=${year}`}
        aria-current={view === "year" ? "page" : undefined}
        className={view === "year" ? on : off}
      >
        Year
      </Link>
    </nav>
  );
}

/**
 * Holidays are added a year at a time (Admin → Holidays), so a year nobody has filled in
 * yet shows none. Says so, rather than leaving people to think they were lost. Only for
 * the years Admin → Holidays opens (2000 to 2100): no one can add another year's.
 */
export function NoHolidaysNote({ year, admin }: { year: number; admin: boolean }) {
  return (
    <p className="text-sm text-muted">
      No company holidays have been added for {year} yet.{" "}
      {admin ? (
        <Link href={`/admin/holidays?year=${year}`} className={cx(textLink, "font-medium text-accent-ink")}>
          Add {year}&apos;s holidays
        </Link>
      ) : (
        "An admin adds them in Admin, Holidays."
      )}
    </p>
  );
}

export function SubscribeLink() {
  return (
    <p className="text-sm">
      <Link href="/calendar/subscriptions" className={quietLink}>
        Add your time off to Google Calendar, Apple Calendar or Outlook
      </Link>
    </p>
  );
}

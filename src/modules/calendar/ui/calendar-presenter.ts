import type { CalendarFilter } from "@/domain/calendar-visibility";
import { formatMonth } from "@/lib/format";
import type { YearNav } from "../application/calendar-viewer";

/** The month view's address: `show` is left out for the default, just me. */
export function calendarMonthHref(month: string, filter: CalendarFilter): string {
  const query = new URLSearchParams({ month });
  if (filter !== "me") query.set("show", filter);
  return `/calendar?${query}`;
}

export function calendarYearHref(year: number): string {
  return `/calendar?view=year&year=${year}`;
}

/** The month the year view's Month tab opens: this month in the current year, else January. */
export function yearViewMonth(nav: YearNav): string {
  return nav.year === nav.current ? nav.today.slice(0, 7) : `${nav.year}-01`;
}

/** The month grid's caption: whose time off it shows, and the month. */
export function monthGridCaption(month: string, filter: CalendarFilter, labels: Record<CalendarFilter, string>): string {
  const whose =
    filter === "me" ? "Your time off" : filter === "team" ? "Your team's time off" : labels.everyone === "Everyone" ? "Everyone's time off" : `${labels.everyone}'s time off`;
  return `${whose} and company holidays in ${formatMonth(month)}`;
}

/** The "Whose time off" pills: one per filter the person may use. */
export function calendarFilterItems(month: string, filter: CalendarFilter, filters: readonly CalendarFilter[], labels: Record<CalendarFilter, string>) {
  return filters.map((f) => ({ href: calendarMonthHref(month, f), label: labels[f], current: f === filter ? ("page" as const) : undefined }));
}

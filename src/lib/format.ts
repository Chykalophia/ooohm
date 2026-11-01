/**
 * Display formatting shared by pages and emails. Pure functions, safe on the client.
 *
 * Dates are formatted in UTC from their `YYYY-MM-DD` parts, so the printed day is the
 * stored day whatever the server's or browser's time zone.
 */

const dayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});
const yearFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric" });

function toUtc(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const PORTION_LABEL = { am: "morning", pm: "afternoon" } as const;

/**
 * A request's dates in words, e.g. "Mon, Nov 2, 2026", "Mon, Nov 2 to Fri, Nov 6, 2026",
 * or "Mon, Nov 2, 2026 (morning)".
 */
export function formatLeaveDates(startDate: string, endDate: string, dayPortion: "full" | "am" | "pm" = "full"): string {
  const start = toUtc(startDate);
  const end = toUtc(endDate);
  const portion = dayPortion === "full" ? "" : ` (${PORTION_LABEL[dayPortion]})`;
  if (startDate === endDate) return `${dayFormat.format(start)}, ${yearFormat.format(start)}${portion}`;
  const sameYear = startDate.slice(0, 4) === endDate.slice(0, 4);
  const from = sameYear ? dayFormat.format(start) : `${dayFormat.format(start)}, ${yearFormat.format(start)}`;
  return `${from} to ${dayFormat.format(end)}, ${yearFormat.format(end)}`;
}

/** "1 day", "0.5 days", "3 days". */
export function formatDays(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export const STATUS_LABEL = {
  pending: "Waiting for approval",
  approved: "Approved",
  rejected: "Declined",
  cancelled: "Cancelled",
} as const;

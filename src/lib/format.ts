/**
 * Display formatting shared by pages and emails. Pure functions, safe on the client.
 *
 * Dates are formatted in UTC from their `YYYY-MM-DD` parts, so the printed day is the
 * stored day whatever the server's or browser's time zone.
 */
import type { Balance, RequestCost } from "@/domain/allowance-policy";
import type { BalanceShortfallDetails } from "@/domain/errors";

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
  return formatCount(days, "day", "days");
}

/** A number with its noun, singular for exactly one: "1 API key", "3 API keys". */
export function formatCount(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The live preview line for a draft request, e.g. "This is 3 days. You'll have 12 days
 * left for 2026." A request over New Year says what each year is charged and what
 * each tracked year keeps. Untracked types get only the first sentence.
 */
export function formatRequestCost(cost: RequestCost): string {
  const split = cost.years.length > 1 ? `: ${cost.years.map((y) => `${y.days} in ${y.year}`).join(", ")}` : "";
  const left = cost.years
    .filter((y): y is typeof y & { remainingAfter: number } => y.remainingAfter !== null)
    .map((y) => `${formatDays(y.remainingAfter)} left for ${y.year}`);
  const after = left.length > 0 ? ` You'll have ${left.join(" and ")}.` : "";
  return `This is ${formatDays(cost.days)}${split}.${after}`;
}

/** Why a request was refused for lack of balance, saying exactly what is left. */
export function formatShortfall(s: BalanceShortfallDetails): string {
  const asked = `That's ${formatDays(s.requested)}${s.yearsSpanned > 1 ? ` in ${s.year}` : ""}`;
  const left = s.remaining > 0 ? `you only have ${formatDays(s.remaining)} left for ${s.year}` : `you have no days left for ${s.year}`;
  return `${asked}, but ${left}.`;
}

/**
 * What a tracked balance is out of: "of 15 days" when that is just the allowance,
 * otherwise with the parts that make it up, so the numbers reconcile, e.g.
 * "of 18 days (15 + 3 carried over)" or "of 13.5 days (15 - 1.5 adjusted)".
 */
export function formatBalanceTotal(b: Extract<Balance, { tracked: true }>): string {
  const parts: string[] = [];
  if (b.carriedOver !== 0) parts.push(`${b.carriedOver < 0 ? "-" : "+"} ${Math.abs(b.carriedOver)} carried over`);
  if (b.adjustment !== 0) parts.push(`${b.adjustment < 0 ? "-" : "+"} ${Math.abs(b.adjustment)} adjusted`);
  const total = `of ${formatDays(b.total)}`;
  return parts.length === 0 ? total : `${total} (${b.allowance} ${parts.join(" ")})`;
}

/**
 * The quiet line under a balance: "2 used · 1 pending", plus "5 carried into 2027"
 * when the rollover moved days out of `year`. Whatever is zero is left out; empty
 * when everything is.
 */
export function formatBalanceUsage(b: Balance, year: number): string {
  const parts: string[] = [];
  if (b.used > 0) parts.push(`${b.used} used`);
  if (b.pending > 0) parts.push(`${b.pending} pending`);
  if (b.tracked && b.carriedOut > 0) parts.push(`${b.carriedOut} carried into ${year + 1}`);
  return parts.join(" · ");
}

const monthFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const longDayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

/** A `YYYY-MM` month in words, e.g. "November 2026". */
export function formatMonth(month: string): string {
  return monthFormat.format(toUtc(`${month}-01`));
}

/** A date in full, e.g. "Thursday, November 26, 2026", for screen readers and titles. */
export function formatLongDate(date: string): string {
  return longDayFormat.format(toUtc(date));
}

/** An instant as its calendar date in `timeZone`, e.g. "Nov 1, 2026". */
export function formatInstantDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(instant);
}

/** An instant as date and time in `timeZone`, e.g. "Nov 1, 2026, 9:05 AM CST". */
export function formatInstantDateTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
}

export const STATUS_LABEL = {
  pending: "Waiting for approval",
  approved: "Approved",
  rejected: "Declined",
  cancelled: "Cancelled",
} as const;

/**
 * The year-end note: "6 days of PTO won’t carry into 2027." or "6 days of PTO and 2
 * days of Sick won’t carry into 2027."
 */
export function formatExpiring(items: readonly { name: string; days: number }[], nextYear: number): string {
  const parts = items.map((i) => `${formatDays(i.days)} of ${i.name}`);
  const list = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${list} won’t carry into ${nextYear}.`;
}

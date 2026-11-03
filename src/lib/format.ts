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

/** One date in short words, e.g. "Mon, Nov 23". */
export function formatShortDay(date: string): string {
  return dayFormat.format(toUtc(date));
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
 * The live preview line for a draft request, e.g. "This request takes 3 days. Afterwards
 * you'd have 12 days left for 2026." A request over New Year says what each year is
 * charged and what each tracked year keeps. Untracked types get only the first sentence.
 */
export function formatRequestCost(cost: RequestCost): string {
  const split = cost.years.length > 1 ? `: ${cost.years.map((y) => `${y.days} in ${y.year}`).join(", ")}` : "";
  const left = cost.years
    .filter((y): y is typeof y & { remainingAfter: number } => y.remainingAfter !== null)
    .map((y) => `${formatDays(y.remainingAfter)} left for ${y.year}`);
  const after = left.length > 0 ? ` Afterwards you'd have ${left.join(" and ")}.` : "";
  return `This request takes ${formatDays(cost.days)}${split}.${after}`;
}

/**
 * What the person just asked for, confirmed after a submit, e.g. "Sent for approval:
 * Mon, Nov 9 to Fri, Nov 13, 2026 (5 days)." or, for someone who approves their own,
 * "Approved: Mon, Nov 9, 2026 (1 day). Enjoy your time off."
 */
export function formatSubmitted(request: {
  approved: boolean;
  startDate: string;
  endDate: string;
  dayPortion: "full" | "am" | "pm";
  days: number;
}): string {
  const what = `${formatLeaveDates(request.startDate, request.endDate, request.dayPortion)} (${formatDays(request.days)})`;
  return request.approved ? `Approved: ${what}. Enjoy your time off.` : `Sent for approval: ${what}.`;
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

const shortDateFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

/** A date in short, e.g. "Nov 26, 2026", where space is tight (a filter chip). */
export function formatShortDate(date: string): string {
  return shortDateFormat.format(toUtc(date));
}

/** A date in full, e.g. "Thursday, November 26, 2026", for screen readers and titles. */
export function formatLongDate(date: string): string {
  return longDayFormat.format(toUtc(date));
}

/** The shapes instants are printed in, each in a company's time zone. */
const INSTANT_FORMATS = {
  date: { month: "short", day: "numeric", year: "numeric" },
  dateTime: { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  short: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  shortWithYear: { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" },
  full: { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" },
  year: { year: "numeric" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

/**
 * One formatter per shape and time zone, made once: a table of a hundred audit rows would
 * otherwise build several hundred, and building one is far slower than using it.
 */
const instantFormatters = new Map<string, Intl.DateTimeFormat>();
function instantFormat(kind: keyof typeof INSTANT_FORMATS, timeZone: string): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone}`;
  let format = instantFormatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, ...INSTANT_FORMATS[kind] });
    instantFormatters.set(key, format);
  }
  return format;
}

/** An instant as its calendar date in `timeZone`, e.g. "Nov 1, 2026". */
export function formatInstantDate(instant: Date, timeZone: string): string {
  return instantFormat("date", timeZone).format(instant);
}

/** An instant as date and time in `timeZone`, e.g. "Nov 1, 2026, 9:05 AM CST". */
export function formatInstantDateTime(instant: Date, timeZone: string): string {
  return instantFormat("dateTime", timeZone).format(instant);
}

/**
 * An instant as a short date and time in `timeZone`, for a table cell: "Nov 2, 10:42 AM",
 * with the year only when it is not `now`'s ("Dec 30, 2025, 4:05 PM"), both read in
 * `timeZone`. No zone: the page says which one once.
 */
export function formatInstantShort(instant: Date, timeZone: string, now: Date): string {
  const year = instantFormat("year", timeZone);
  return instantFormat(year.format(instant) === year.format(now) ? "short" : "shortWithYear", timeZone).format(instant);
}

/** An instant to the second, with its zone, e.g. "Nov 2, 2026, 10:42:07 AM CST": the full record. */
export function formatInstantFull(instant: Date, timeZone: string): string {
  return instantFormat("full", timeZone).format(instant);
}

export const STATUS_LABEL = {
  pending: "Waiting for approval",
  approved: "Approved",
  rejected: "Declined",
  cancelled: "Cancelled",
} as const;

export const ROLE_LABEL = { employee: "Employee", manager: "Manager", admin: "Admin" } as const;

/** Weekday names, Monday first, indexed by ISO weekday minus one. */
export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** What is left, in words, with an overdrawn balance said plainly rather than as a negative. */
export function formatRemaining(balance: Balance): string {
  if (!balance.tracked) return "No limit";
  if (balance.remaining < 0) return `${formatDays(-balance.remaining)} over`;
  return `${formatDays(balance.remaining)} left`;
}

/** Why submitted leave was recounted: the holidays on its dates that changed, or the working days. */
export type RecountCause =
  | {
      kind: "holidays";
      added: readonly { date: string; name: string }[];
      removed: readonly { date: string; name: string }[];
    }
  | { kind: "working_days" };

/**
 * The cause of a recount as the start of a sentence, e.g. "Thu, Dec 24, 2026 is now a
 * company holiday (Christmas Eve)" or "The company's working days changed".
 */
export function formatRecountCause(cause: RecountCause): string {
  if (cause.kind === "working_days") return "The company's working days changed";
  const { added, removed } = cause;
  if (added.length === 1 && removed.length === 0) {
    return `${formatLeaveDates(added[0].date, added[0].date)} is now a company holiday (${added[0].name})`;
  }
  if (removed.length === 1 && added.length === 0) {
    return `${formatLeaveDates(removed[0].date, removed[0].date)} is no longer a company holiday`;
  }
  if (removed.length === 0) return `${added.map((h) => h.name).join(", ")} are now company holidays`;
  return "The company holidays during your time off changed";
}

/**
 * Why a request has nothing to count: "Fri, Dec 25, 2026 is Christmas Day, a company
 * holiday, so there's nothing to request." when the dates are one holiday, the holidays
 * named when there are several, and the plain message when there are none.
 */
export function formatNoWorkingDays(holidays: readonly { date: string; name: string }[]): string {
  if (holidays.length === 0) return "Those dates are all weekends or days off, so there's nothing to request.";
  if (holidays.length === 1) {
    const [h] = holidays;
    return `${formatLeaveDates(h.date, h.date)} is ${h.name}, a company holiday, so there's nothing to request.`;
  }
  return `Those dates are days off or company holidays (${holidays.map((h) => h.name).join(", ")}), so there's nothing to request.`;
}

/**
 * The confirmation an admin sees after a calendar change recounted submitted leave, e.g.
 * "2 requests were recounted; 1 now takes no days. Ana Test is now 1 day over on PTO
 * for 2026." Empty when nothing changed.
 */
export function formatRecountOutcome(outcome: {
  recounted: number;
  nowFree: number;
  overdrawn: readonly { personName: string; leaveTypeName: string; year: number; over: number }[];
}): string {
  const parts: string[] = [];
  if (outcome.recounted > 0) {
    const free = outcome.nowFree > 0 ? `; ${outcome.nowFree} now ${outcome.nowFree === 1 ? "takes" : "take"} no days` : "";
    parts.push(`${formatCount(outcome.recounted, "request was", "requests were")} recounted${free}.`);
  }
  for (const o of outcome.overdrawn) {
    parts.push(`${o.personName} is now ${formatDays(o.over)} over on ${o.leaveTypeName} for ${o.year}.`);
  }
  return parts.join(" ");
}

/**
 * The year-end note: "6 days of PTO won’t carry into 2027." or "6 days of PTO and 2
 * days of Sick won’t carry into 2027."
 */
export function formatExpiring(items: readonly { name: string; days: number }[], nextYear: number): string {
  const parts = items.map((i) => `${formatDays(i.days)} of ${i.name}`);
  const list = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${list} won’t carry into ${nextYear}.`;
}

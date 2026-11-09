/**
 * Coverage: how many people of a department may be off at once (`departments.max_off`).
 * A limit only ever warns. Nothing is blocked: the requester sees it before sending and
 * the approver sees it before deciding. Pending requests count as well as approved ones,
 * because both are on the calendar.
 */
import { eachDate, isoWeekday } from "./calendar-date";

/** The most a department's limit can be set to. */
export const MAX_OFF_LIMIT = 999;

/** One person's pending or approved leave, as the team calendar has it. */
export interface CoverageLeave {
  userId: string;
  departmentId: string | null;
  startDate: string;
  endDate: string;
}

/** The request being made or decided, and the limit of the requester's department. */
export interface CoverageTarget {
  requesterId: string;
  departmentId: string;
  startDate: string;
  endDate: string;
  /** At most this many of the department off on one working day. */
  maxOff: number;
}

/** Working days that cost leave: weekdays the company works, minus its holidays. */
export interface CoverageCalendar {
  /** ISO weekdays that are working days (1 = Monday ... 7 = Sunday). */
  workingDays: readonly number[];
  holidays: readonly { date: string }[];
}

/** The target goes over its department's limit on `days` working days, the first being `firstDate`. */
export interface CoverageBreach {
  /** People of the department off on the worst day, the requester included. */
  peak: number;
  /** The first working day over the limit. */
  firstDate: string;
  /** Working days of the target with more than the limit off. */
  days: number;
  maxOff: number;
}

/**
 * Whether the target would put more of its department off at once than the limit
 * allows, counting the requester and each other person in the department whose leave
 * covers a working day of the target (each person once a day, however many requests
 * they have). Half days count as off. Weekends and holidays never count.
 *
 * @param leave Pending and approved leave of anyone; other departments' is ignored.
 * @returns `null` when it stays within the limit.
 */
export function coverageBreach(target: CoverageTarget, leave: readonly CoverageLeave[], calendar: CoverageCalendar): CoverageBreach | null {
  const working = new Set(calendar.workingDays);
  const holidays = new Set(calendar.holidays.map((h) => h.date));
  const others = leave.filter(
    (l) => l.userId !== target.requesterId && l.departmentId === target.departmentId && l.endDate >= target.startDate && l.startDate <= target.endDate,
  );
  const over = eachDate(target.startDate, target.endDate).flatMap((date) => {
    if (!working.has(isoWeekday(date)) || holidays.has(date)) return [];
    const off = new Set(others.filter((l) => l.startDate <= date && l.endDate >= date).map((l) => l.userId)).size + 1;
    return off > target.maxOff ? [{ date, off }] : [];
  });
  if (over.length === 0) return null;
  return { peak: Math.max(...over.map((d) => d.off)), firstDate: over[0].date, days: over.length, maxOff: target.maxOff };
}

/**
 * The one warning line, the same for the requester and the approver: "This would put 3
 * people in Design off on Tue, Mar 3. The limit is 2." or, over several days, "This would
 * put up to 4 people in Design off at once, on 3 days from Tue, Mar 3. The limit is 2."
 *
 * @param formatDay How a date reads, e.g. "Tue, Mar 3".
 * @param booked It is already booked (heads-up mode): "This puts…" rather than "This would put…".
 */
export function describeCoverageBreach(breach: CoverageBreach, departmentName: string, formatDay: (date: string) => string, booked = false): string {
  const puts = booked ? "This puts" : "This would put";
  const limit = `The limit is ${breach.maxOff}.`;
  if (breach.days === 1) return `${puts} ${breach.peak} people in ${departmentName} off on ${formatDay(breach.firstDate)}. ${limit}`;
  return `${puts} up to ${breach.peak} people in ${departmentName} off at once, on ${breach.days} days from ${formatDay(breach.firstDate)}. ${limit}`;
}

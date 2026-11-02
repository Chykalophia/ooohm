/**
 * TimeOff.Management's balance rules, re-implemented from its documented data model so
 * the importer can prove that OOOhm reproduces every person's balance.
 *
 * TimeOff keeps **one allowance pool per person and year**, shared by every leave type
 * with `use_allowance`:
 *
 * - nominal = the department's `allowance` (TimeOff has no per-person allowance);
 * - employment adjustment = a pro-rating for the years someone starts or leaves in:
 *   `round(nominal × D / 365) − nominal`, where D is the whole days from the start date
 *   (or Jan 1) to the end date (or Dec 31) of that year;
 * - total = nominal + employment adjustment + the year's `adjustment` + the year's
 *   `carried_over_allowance` (both from `user_allowance_adjustment`, 0 without a row);
 * - used = the deducted days of approved (`approved` or `pended revoke`) leave of
 *   `use_allowance` types, counted per year;
 * - remaining = total − used, or 0 for a year before the person started.
 *
 * Pending (`new`) leave is not subtracted: TimeOff shows it apart. Department
 * `is_accrued_allowance` (showing only what has been earned so far) is not applied:
 * OOOhm grants the full year, so the full-year figure is what both sides compare.
 */
import { addDays } from "@/domain/allowance-policy";
import { type CalendarDate, eachDate, isoWeekday, toEpochDay } from "@/domain/calendar-date";
import { TIMEOFF_DAY_PART, TIMEOFF_SCHEDULE_WORKING_DAY, TIMEOFF_STATUS, type TimeOffSchedule } from "@/domain/timeoff/source";

/** TimeOff's default working week when no schedule is stored: Monday to Friday. */
export const TIMEOFF_DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

/** Whether TimeOff counts a leave as taken: `approved` and `pended revoke` (a revoke not yet decided). */
export function isTimeOffApproved(status: number): boolean {
  return status === TIMEOFF_STATUS.approved || status === TIMEOFF_STATUS.pendedRevoke;
}

/** The ISO weekdays (1 = Monday) a TimeOff schedule marks as full working days, ascending. */
export function scheduleWorkingDays(schedule: Pick<TimeOffSchedule, "days">): number[] {
  return schedule.days.flatMap((value, i) => (value === TIMEOFF_SCHEDULE_WORKING_DAY ? [i + 1] : []));
}

/** The calendar a leave is counted against: one person's working weekdays and the company's bank holidays. */
export interface TimeOffWorkCalendar {
  workingDays: ReadonlySet<number>;
  holidays: ReadonlySet<CalendarDate>;
}

/** The date part of a TimeOff leave. */
export interface TimeOffLeaveDates {
  dateStart: CalendarDate;
  dateEnd: CalendarDate;
  dayPartStart: number;
  dayPartEnd: number;
}

function isHalfDay(dayPart: number): boolean {
  return dayPart !== TIMEOFF_DAY_PART.allDay;
}

/**
 * The days a leave takes from the allowance, the way TimeOff counts them.
 *
 * Every date from start to end that is a working day of the person's schedule and not a
 * bank holiday counts 1 (only dates in `year`, when given). Then, on that count:
 *
 * - exactly 1 day: minus 0.5 when the leave's **first** date is a half day;
 * - more than 1: minus 0.5 when the first date is a half day, and 0.5 more when the
 *   last date is.
 *
 * The half-day rule looks at the leave's first and last dates, not at the days that
 * survived the filter, so TimeOff can take half a day off a count that does not include
 * that date (a half day on a weekend, or in the other year of a leave over New Year).
 * The importer reproduces this exactly and reports where OOOhm's own count differs.
 *
 * Callers decide whether the leave type uses the allowance at all.
 */
export function timeOffDeductedDays(leave: TimeOffLeaveDates, calendar: TimeOffWorkCalendar, year?: number): number {
  let count = 0;
  for (const date of eachDate(leave.dateStart, leave.dateEnd)) {
    if (year !== undefined && Number(date.slice(0, 4)) !== year) continue;
    if (calendar.holidays.has(date) || !calendar.workingDays.has(isoWeekday(date))) continue;
    count++;
  }
  if (count === 1 && isHalfDay(leave.dayPartStart)) return 0.5;
  if (count > 1) {
    const halves = (isHalfDay(leave.dayPartStart) ? 1 : 0) + (isHalfDay(leave.dayPartEnd) ? 1 : 0);
    return addDays(count, -0.5 * halves);
  }
  return count;
}

const yearOf = (date: CalendarDate) => Number(date.slice(0, 4));

/**
 * TimeOff's pro-rating for a year someone starts or stops working in:
 * `round(nominal × D / 365) − nominal` (JavaScript `Math.round`, a fixed 365 even in
 * leap years), where D is the whole days from the start date (Jan 1 when they started
 * earlier) to the end date (Dec 31 when they stay past the year). A full year gives
 * D = 364, so small allowances round back to themselves and only partial years change.
 *
 * 0 when the person neither started nor stopped in `year`.
 */
export function employmentRangeAdjustment(
  nominal: number,
  employment: { startDate: CalendarDate | null; endDate: CalendarDate | null },
  year: number,
): number {
  const startsInYear = employment.startDate !== null && yearOf(employment.startDate) === year;
  const endsByYear = employment.endDate !== null && yearOf(employment.endDate) <= year;
  if (!startsInYear && !endsByYear) return 0;
  const from = toEpochDay(startsInYear ? employment.startDate! : `${year}-01-01`);
  const to = toEpochDay(endsByYear ? employment.endDate! : `${year}-12-31`);
  const prorated = Math.round((nominal * (to - from)) / 365);
  return prorated - nominal || 0;
}

/** One person's TimeOff balance for one year, with each part shown. */
export interface TimeOffYearBalance {
  year: number;
  /** The department's allowance. */
  nominal: number;
  employmentAdjustment: number;
  /** `user_allowance_adjustment.adjustment`. */
  adjustment: number;
  /** `user_allowance_adjustment.carried_over_allowance`. */
  carriedOver: number;
  total: number;
  /** Approved days of allowance-using leave in the year. */
  used: number;
  /** total − used; 0 for a year before the person started. */
  remaining: number;
  /** The person started after this year: TimeOff reports nothing available. */
  beforeStart: boolean;
}

/** {@link TimeOffYearBalance} from its inputs. */
export function timeOffYearBalance(input: {
  year: number;
  nominal: number;
  startDate: CalendarDate | null;
  endDate: CalendarDate | null;
  adjustment: number;
  carriedOver: number;
  used: number;
}): TimeOffYearBalance {
  const employmentAdjustment = employmentRangeAdjustment(input.nominal, input, input.year);
  const total = addDays(input.nominal, employmentAdjustment, input.adjustment, input.carriedOver);
  const beforeStart = input.startDate !== null && yearOf(input.startDate) > input.year;
  return {
    year: input.year,
    nominal: input.nominal,
    employmentAdjustment,
    adjustment: input.adjustment,
    carriedOver: input.carriedOver,
    total,
    used: addDays(input.used),
    remaining: beforeStart ? 0 : addDays(total, -input.used),
    beforeStart,
  };
}

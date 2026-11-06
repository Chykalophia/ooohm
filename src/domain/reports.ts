/**
 * Leave reports for admins and managers: who took how much time off, when, of which
 * type, and how that compares with earlier years. Pure functions over rows a service
 * loaded; see `buildLeaveReport`.
 */
import { type Actor, isAdmin } from "./actor";
import { addDays } from "./allowance-policy";
import type { CalendarDate } from "./calendar-date";
import { eachDate, isoWeekday } from "./calendar-date";
import { monthOf, type YearMonth } from "./calendar";
import { toCsv } from "./csv";
import type { WorkCalendar, YearDays } from "./leave-days";
import type { DayPortion, LeaveRange, LeaveStatus } from "./leave-request";

/** How many years the trend shows, ending with the report's year. */
export const REPORT_TREND_YEARS = 5;

/** Reports are for admins and managers. Everyone else gets a 404. */
export function canViewReports(actor: Pick<Actor, "role">): boolean {
  return actor.role === "admin" || actor.role === "manager";
}

/** Whose leave a report covers: the whole company, or one manager's direct reports. */
export type ReportScope = { kind: "company" } | { kind: "team"; managerId: string };

/** Admins report on the company; a manager on the people who report to them. */
export function reportScopeFor(actor: Pick<Actor, "id" | "role">): ReportScope {
  return isAdmin(actor) ? { kind: "company" } : { kind: "team", managerId: actor.id };
}

/**
 * Whether a report shows days left: the same rule as a team member's page
 * (`canSeeLeaveDetails`), applied to everyone a manager's report covers. Days taken are
 * not private (the team calendar shows who is off and when); balances are.
 */
export function canSeeReportBalances(actor: Pick<Actor, "role">, managersSeeDetails: boolean): boolean {
  return isAdmin(actor) || managersSeeDetails;
}

/** The days a request costs in one month. */
export interface MonthDays {
  month: YearMonth;
  days: number;
}

/**
 * Working days a range costs in each month, as the calendar counts them today
 * (weekends and holidays skipped, a half day 0.5). Months with none are left out.
 */
export function splitLeaveDaysByMonth(range: LeaveRange, calendar: WorkCalendar): MonthDays[] {
  const working = new Set(calendar.workingDays);
  const holidays = new Set(calendar.holidays);
  const perDay = range.dayPortion === "full" ? 1 : 0.5;
  const out: MonthDays[] = [];
  for (const date of eachDate(range.startDate, range.endDate)) {
    if (!working.has(isoWeekday(date)) || holidays.has(date)) continue;
    const month = monthOf(date);
    const last = out.at(-1);
    if (last?.month === month) last.days += perDay;
    else out.push({ month, days: perDay });
  }
  return out;
}

/**
 * What a request charged `year` (`stored`, from its saved split), spread over that
 * year's months, so the months always add up to what balances count.
 *
 * The calendar's split is used as it is when it agrees. A closed year keeps what it was
 * charged after a later holiday or working-days change, so the two can differ: then the
 * stored days are shared out in proportion to the calendar's split, in tenths (the
 * largest remainders get the leftovers), or put on the range's first month in the year
 * when the calendar now counts nothing there.
 */
export function allocateYearToMonths(range: LeaveRange, calendar: WorkCalendar, year: number, stored: number): MonthDays[] {
  if (stored <= 0) return [];
  const prefix = `${year}-`;
  const counted = splitLeaveDaysByMonth(range, calendar).filter((m) => m.month.startsWith(prefix));
  const total = addDays(...counted.map((m) => m.days));
  if (total === stored) return counted;
  if (total === 0) {
    const first = range.startDate.startsWith(prefix) ? range.startDate : `${year}-01-01`;
    return [{ month: monthOf(first), days: stored }];
  }
  const tenths = Math.round(stored * 10);
  const shares = counted.map((m) => (m.days / total) * tenths);
  const floors = shares.map(Math.floor);
  let left = tenths - floors.reduce((s, n) => s + n, 0);
  const byRemainder = shares.map((s, i) => [s - floors[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of byRemainder) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return counted.map((m, i) => ({ month: m.month, days: floors[i] / 10 })).filter((m) => m.days > 0);
}

/** One request as a report reads it: no note, no decision note. */
export interface ReportRequest {
  id: string;
  userId: string;
  leaveTypeId: string;
  status: LeaveStatus;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  approverId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  /** What it was charged per year, as stored (`leave_request_days`). */
  split: readonly YearDays[];
}

export interface ReportPerson {
  id: string;
  /** Already labelled for others to see (`teamLabel`). */
  name: string;
  departmentId: string | null;
  isActive: boolean;
}

export interface ReportLeaveType {
  id: string;
  name: string;
  color: string;
}

export interface LeaveReportInput {
  year: number;
  /** Today in the company's time zone: months after its month are "booked ahead". */
  today: CalendarDate;
  workingDays: readonly number[];
  /** Holidays of the report's year and the one before (for the month split). */
  holidays: readonly CalendarDate[];
  /** In display order. */
  leaveTypes: readonly ReportLeaveType[];
  /** In display order (by name). */
  departments: readonly { id: string; name: string }[];
  /** Everyone the report covers, active or not. */
  people: readonly ReportPerson[];
  /** Their requests that charge any of the trend's years. */
  requests: readonly ReportRequest[];
  /**
   * Days left this year per person (summed over tracked leave types; `null` when none
   * is tracked), or `null` when the viewer may not see balances.
   */
  remaining: ReadonlyMap<string, number | null> | null;
}

export interface ReportMonth {
  month: YearMonth;
  /** Approved days, by leave type in the input's order; types with none left out. */
  byType: { leaveTypeId: string; days: number }[];
  total: number;
  /** After today's month: booked, not yet taken. */
  ahead: boolean;
}

export interface ReportPersonRow {
  userId: string;
  name: string;
  departmentName: string | null;
  isActive: boolean;
  /** Approved days per leave type id. */
  byType: Record<string, number>;
  approvedDays: number;
  pendingDays: number;
  remaining: number | null;
}

export interface LeaveReport {
  year: number;
  showsBalances: boolean;
  leaveTypes: readonly ReportLeaveType[];
  totals: {
    approvedDays: number;
    pendingDays: number;
    /** People with approved days in the year. */
    peopleOff: number;
    /** Active people the report covers. */
    headcount: number;
    /** Active people's approved days over the headcount, to one decimal. */
    daysPerPerson: number;
    /** Requests charging the year, by status. */
    requests: Record<LeaveStatus, number>;
    /** Median hours from request to an approver's decision; `null` with no decisions. */
    medianDecisionHours: number | null;
    decisions: number;
  };
  months: ReportMonth[];
  /** The year before's approved days per month, January first. */
  previousYearMonths: number[];
  /** Approved days per year, oldest first, ending with the report's year. */
  trend: { year: number; days: number }[];
  /** Leave types with approved days, most first. */
  byType: (ReportLeaveType & { leaveTypeId: string; days: number; requests: number })[];
  /** Each department, then "No department": approved days (everyone's) and days per active person (theirs). */
  byDepartment: { departmentId: string | null; name: string; headcount: number; days: number; daysPerPerson: number }[];
  /** Active people, and inactive ones with leave in the year, by name. */
  people: ReportPersonRow[];
}

const perPerson = (days: number, people: number) => (people === 0 ? 0 : Math.round((days / people) * 10) / 10);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const daysIn = (r: ReportRequest, year: number) => r.split.find((s) => s.year === year)?.days ?? 0;

/** Approved days per month of `year`, January first, each split as {@link allocateYearToMonths} does. */
function monthlyApproved(input: LeaveReportInput, year: number): Map<YearMonth, Map<string, number>> {
  const calendar = { workingDays: input.workingDays, holidays: input.holidays };
  const months = new Map<YearMonth, Map<string, number>>();
  for (let m = 1; m <= 12; m++) months.set(`${year}-${String(m).padStart(2, "0")}`, new Map());
  for (const r of input.requests) {
    if (r.status !== "approved") continue;
    for (const part of allocateYearToMonths(r, calendar, year, daysIn(r, year))) {
      const byType = months.get(part.month);
      if (byType) byType.set(r.leaveTypeId, addDays(byType.get(r.leaveTypeId) ?? 0, part.days));
    }
  }
  return months;
}

/**
 * Everything the reports screen and its CSV show for one year, from the people,
 * requests and balances in scope. Days come from each request's stored per-year split
 * (what balances count), never from a recount; only their spread over months uses the
 * calendar.
 */
export function buildLeaveReport(input: LeaveReportInput): LeaveReport {
  const { year } = input;
  const thisMonth = monthOf(input.today);
  const typeOrder = input.leaveTypes.map((t) => t.id);
  const inYear = input.requests.filter((r) => daysIn(r, year) > 0);
  const approved = inYear.filter((r) => r.status === "approved");

  const months: ReportMonth[] = [...monthlyApproved(input, year)].map(([month, byTypeMap]) => {
    const byType = typeOrder.filter((id) => byTypeMap.has(id)).map((id) => ({ leaveTypeId: id, days: byTypeMap.get(id) ?? 0 }));
    return { month, byType, total: addDays(...byType.map((t) => t.days)), ahead: month > thisMonth };
  });
  const previousYearMonths = [...monthlyApproved(input, year - 1).values()].map((byType) => addDays(...byType.values()));

  const trend = Array.from({ length: REPORT_TREND_YEARS }, (_, i) => year - REPORT_TREND_YEARS + 1 + i).map((y) => ({
    year: y,
    days: addDays(...input.requests.filter((r) => r.status === "approved").map((r) => daysIn(r, y))),
  }));

  const approvedOf = (userId: string) => approved.filter((r) => r.userId === userId);
  const active = input.people.filter((p) => p.isActive);
  const approvedDays = addDays(...approved.map((r) => daysIn(r, year)));
  /** Per person counts only the people still here, over and under the line. */
  const daysOf = (people: readonly ReportPerson[]) => addDays(...people.flatMap((p) => approvedOf(p.id).map((r) => daysIn(r, year))));

  const byType = input.leaveTypes
    .map((t) => {
      const of = approved.filter((r) => r.leaveTypeId === t.id);
      return { ...t, leaveTypeId: t.id, days: addDays(...of.map((r) => daysIn(r, year))), requests: of.length };
    })
    .filter((t) => t.days > 0)
    .sort((a, b) => b.days - a.days);

  const departmentGroups = [...input.departments.map((d) => ({ departmentId: d.id as string | null, name: d.name })), { departmentId: null, name: "No department" }];
  const byDepartment = departmentGroups
    .map(({ departmentId, name }) => {
      const members = input.people.filter((p) => p.departmentId === departmentId);
      const headcount = members.filter((p) => p.isActive).length;
      const days = daysOf(members);
      return { departmentId, name, headcount, days, daysPerPerson: perPerson(daysOf(members.filter((p) => p.isActive)), headcount) };
    })
    .filter((d) => d.headcount > 0 || d.days > 0);

  const departmentName = new Map(input.departments.map((d) => [d.id, d.name]));
  const people = input.people
    .map((p): ReportPersonRow => {
      const mine = inYear.filter((r) => r.userId === p.id);
      const byTypeDays: Record<string, number> = {};
      for (const r of mine) if (r.status === "approved") byTypeDays[r.leaveTypeId] = addDays(byTypeDays[r.leaveTypeId] ?? 0, daysIn(r, year));
      return {
        userId: p.id,
        name: p.name,
        departmentName: p.departmentId ? (departmentName.get(p.departmentId) ?? null) : null,
        isActive: p.isActive,
        byType: byTypeDays,
        approvedDays: addDays(...Object.values(byTypeDays)),
        pendingDays: addDays(...mine.filter((r) => r.status === "pending").map((r) => daysIn(r, year))),
        remaining: input.remaining?.get(p.id) ?? null,
      };
    })
    .filter((p) => p.isActive || p.approvedDays > 0 || p.pendingDays > 0)
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));

  const waits = inYear
    .filter((r) => (r.status === "approved" || r.status === "rejected") && r.decidedAt && r.approverId !== r.userId)
    .map((r) => ((r.decidedAt as Date).getTime() - r.createdAt.getTime()) / 3_600_000)
    .filter((hours) => hours > 0);

  const count = (status: LeaveStatus) => inYear.filter((r) => r.status === status).length;
  return {
    year,
    showsBalances: input.remaining !== null,
    leaveTypes: input.leaveTypes,
    totals: {
      approvedDays,
      pendingDays: addDays(...inYear.filter((r) => r.status === "pending").map((r) => daysIn(r, year))),
      peopleOff: new Set(approved.map((r) => r.userId)).size,
      headcount: active.length,
      daysPerPerson: perPerson(daysOf(active), active.length),
      requests: { approved: count("approved"), pending: count("pending"), rejected: count("rejected"), cancelled: count("cancelled") },
      medianDecisionHours: median(waits),
      decisions: waits.length,
    },
    months,
    previousYearMonths,
    trend,
    byType,
    byDepartment,
    people,
  };
}

/**
 * The report's people as a spreadsheet: one row per person, a column of approved days
 * per leave type, then totals, and days left only when the report shows balances.
 */
export function reportCsv(report: LeaveReport): string {
  const header = ["Person", "Department", "Active", ...report.leaveTypes.map((t) => t.name), "Approved days", "Pending days"];
  if (report.showsBalances) header.push("Days left");
  const rows = report.people.map((p) => {
    const row = [p.name, p.departmentName, p.isActive, ...report.leaveTypes.map((t) => p.byType[t.id] ?? 0), p.approvedDays, p.pendingDays];
    if (report.showsBalances) row.push(p.remaining);
    return row;
  });
  return toCsv(header, rows);
}

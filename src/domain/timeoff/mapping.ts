/**
 * Maps a TimeOff.Management snapshot onto OOOhm's model: a pure plan the import service
 * then writes. Nothing here touches a database; every decision the importer makes about
 * the source data is made (and unit tested) here.
 *
 * The one real model difference is the allowance. TimeOff has **one pool per person and
 * year**, consumed by every leave type with `use_allowance`; OOOhm keeps an allowance
 * per leave type. The plan maps the pool onto one OOOhm leave type (the **pool type**),
 * so each person's remaining balance stays the same number:
 *
 * - The pool type is the TimeOff type named by `poolTypeName`, else the first
 *   `use_allowance` type by sort order. Its allowance rows carry the pool: `days` = the
 *   department allowance, `adjustment_days` = the year's adjustment plus TimeOff's
 *   pro-rating for a start or end year, `carried_over_days` = the year's carried-over
 *   allowance. It comes first in the leave type order, and its default allowance is
 *   the departments' allowance when they all have the same one (else none, with a
 *   `pool_type_no_default` warning), so people invited later are tracked too.
 * - When several TimeOff types use the pool, they can only keep one balance if they
 *   become one OOOhm type, so the plan refuses unless `mergePoolTypes` is set; then
 *   their leave all lands in the pool type, and each request keeps its original type
 *   name at the start of its note (`[TimeOff: Training] ...`). Splitting the pool into
 *   separate per-type allowances would have to invent how much of it each type gets, and
 *   would change what people see as left.
 * - Types without `use_allowance` import untracked, or, when TimeOff caps them with a
 *   yearly `limit`, as a tracked type whose default allowance is that limit.
 */
import { addDays } from "@/domain/allowance-policy";
import type { Role } from "@/domain/actor";
import { type CalendarDate, fromEpochDay, isCalendarDate, toEpochDay } from "@/domain/calendar-date";
import { isSupportedTimeZone } from "@/domain/company-settings";
import { DomainError, isDomainError } from "@/domain/errors";
import { normalizeHolidayName } from "@/domain/holidays";
import { splitLeaveDaysByYear, type YearDays } from "@/domain/leave-days";
import { type DayPortion, type LeaveRange, type LeaveStatus, MAX_REQUEST_SPAN_DAYS, NOTE_MAX_LENGTH } from "@/domain/leave-request";
import {
  LEAVE_TYPE_CODE_MAX_LENGTH,
  LEAVE_TYPE_NAME_MAX_LENGTH,
  MAX_ALLOWANCE_DAYS,
  normalizeLeaveTypeColor,
} from "@/domain/leave-type-settings";
import { normalizeDepartmentName, normalizeEmail, normalizePersonName, PERSON_NAME_MAX_LENGTH } from "@/domain/people";
import {
  isTimeOffApproved,
  scheduleWorkingDays,
  TIMEOFF_DEFAULT_WORKING_DAYS,
  timeOffDeductedDays,
  type TimeOffWorkCalendar,
  timeOffYearBalance,
  type TimeOffYearBalance,
} from "@/domain/timeoff/balance";
import {
  TIMEOFF_DAY_PART,
  TIMEOFF_STATUS,
  type TimeOffCompany,
  type TimeOffLeave,
  type TimeOffLeaveType,
  type TimeOffSnapshot,
  type TimeOffUser,
} from "@/domain/timeoff/source";

/** How the import was asked to run. */
export interface ImportPlanOptions {
  /** Which TimeOff company to import; required when the file holds more than one. */
  timeoffCompanyId?: number;
  /** The TimeOff leave type whose name the pool type takes. Default: the first `use_allowance` type. */
  poolTypeName?: string;
  /** Merge several `use_allowance` types into the pool type instead of refusing. */
  mergePoolTypes?: boolean;
  /** The current year in the target company's time zone. */
  currentYear: number;
  /** Today in the target company's time zone, for who is still employed. */
  today: CalendarDate;
  /**
   * Holidays the target company already has. OOOhm counts imported leave against these
   * as well as TimeOff's bank holidays (the union is the company calendar after the
   * import), while TimeOff's own figures keep TimeOff's holidays only, so a date only
   * OOOhm treats as a holiday surfaces as a {@link LeaveCostDifference}.
   */
  existingHolidays?: ReadonlySet<CalendarDate>;
}

/** Something the importer could not carry over as is, for the report. Never fatal. */
export interface ImportIssue {
  code: string;
  message: string;
  /** The TimeOff record it is about, when there is one. */
  timeoffId?: number;
  email?: string;
}

export interface PlannedCompany {
  timeoffId: number;
  name: string;
  /** `null` when TimeOff's zone is missing or unknown here; the target company's zone stays. */
  timezone: string | null;
  /** ISO weekdays of TimeOff's company schedule. */
  workingDays: number[];
  carryoverEnabled: boolean;
  /** Carryover cap; `null` = no cap. */
  carryoverMaxDays: number | null;
}

export interface PlannedDepartment {
  /** The TimeOff department id (the first one, when names repeat). */
  key: number;
  name: string;
}

export interface PlannedPerson {
  /** The TimeOff user id kept for this email. */
  key: number;
  email: string;
  name: string;
  role: Role;
  departmentKey: number | null;
  managerKey: number | null;
  canSelfApprove: boolean;
  isActive: boolean;
  /** ISO timestamp: the employment start date, so the year rollover sees when they joined. */
  createdAt: string;
}

export interface PlannedLeaveType {
  /** The OOOhm code; unique in the plan. */
  key: string;
  name: string;
  color: string;
  countsAgainstAllowance: boolean;
  defaultAllowanceDays: number | null;
  carryoverEnabled: boolean;
  carryoverMaxDays: number | null;
  sortOrder: number;
  /** The type that holds TimeOff's shared allowance pool. */
  pool: boolean;
  /** Every TimeOff type that maps onto it. */
  timeoffTypeIds: number[];
}

export interface PlannedHoliday {
  date: CalendarDate;
  name: string;
  timeoffId: number;
}

export interface PlannedAllowance {
  personKey: number;
  leaveTypeKey: string;
  year: number;
  days: number;
  adjustmentDays: number;
  carriedOverDays: number;
  /** Where `adjustmentDays` came from: TimeOff's adjustment and its pro-rating. */
  timeoffAdjustment: number;
  employmentAdjustment: number;
}

export interface PlannedRequest {
  personKey: number;
  leaveTypeKey: string;
  timeoffLeaveId: number;
  /** 1-based; a TimeOff leave with half-day ends becomes up to three OOOhm requests. */
  part: number;
  parts: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  days: number;
  split: YearDays[];
  status: LeaveStatus;
  approverKey: number | null;
  note: string | null;
  decisionNote: string | null;
  createdAt: string | null;
  decidedAt: string | null;
}

/** A leave OOOhm counts differently from TimeOff in one year, and why. */
export interface LeaveCostDifference {
  personKey: number;
  timeoffLeaveId: number;
  year: number;
  timeoff: number;
  ooohm: number;
  /**
   * `personal_schedule` (their TimeOff schedule is not the company's), `company_holiday`
   * (the target company already has a holiday TimeOff does not) or `half_day_rule`.
   */
  reason: "personal_schedule" | "company_holiday" | "half_day_rule";
}

/** TimeOff's balance for one person and year: what the import must reproduce. */
export interface ExpectedBalance {
  personKey: number;
  year: number;
  timeoff: TimeOffYearBalance;
}

export interface ImportPlan {
  company: PlannedCompany;
  departments: PlannedDepartment[];
  people: PlannedPerson[];
  leaveTypes: PlannedLeaveType[];
  /** `null` when no TimeOff type uses the allowance: there is no pool to carry. */
  poolTypeKey: string | null;
  holidays: PlannedHoliday[];
  allowances: PlannedAllowance[];
  requests: PlannedRequest[];
  expected: ExpectedBalance[];
  leaveCostDifferences: LeaveCostDifference[];
  warnings: ImportIssue[];
  /** Records left out because they clash (duplicate or invalid emails). */
  conflicts: ImportIssue[];
  skipped: { users: number; leaves: number };
}

const STATUS_MAP: Readonly<Record<number, LeaveStatus>> = {
  [TIMEOFF_STATUS.new]: "pending",
  [TIMEOFF_STATUS.approved]: "approved",
  [TIMEOFF_STATUS.rejected]: "rejected",
  [TIMEOFF_STATUS.pendedRevoke]: "approved",
  [TIMEOFF_STATUS.canceled]: "cancelled",
};

/** Colours for TimeOff types whose colour is not a hex value (older files store CSS class names). */
const FALLBACK_COLORS = ["#0f766e", "#b45309", "#be123c", "#7c3aed", "#1d4ed8", "#4d7c0f", "#6b7280"];

/** TimeOff offers "all days" as a very large carry-over number; beyond a year of days it means no cap. */
const UNLIMITED_CARRY_OVER = MAX_ALLOWANCE_DAYS;

const yearOf = (date: CalendarDate) => Number(date.slice(0, 4));
const refuse = (message: string): never => {
  throw new DomainError("import_refused", message);
};

/** An OOOhm leave type code from a TimeOff name: uppercase letters and digits, `_` between words, at most 12. */
export function leaveTypeCodeFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, LEAVE_TYPE_CODE_MAX_LENGTH)
      .replace(/_+$/, "") || "TYPE";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const code = base.slice(0, LEAVE_TYPE_CODE_MAX_LENGTH - suffix.length).replace(/_+$/, "") + suffix;
    if (!taken.has(code)) return code;
  }
}

/** The OOOhm day portion for a TimeOff day part. */
function portionOf(dayPart: number): DayPortion {
  if (dayPart === TIMEOFF_DAY_PART.morning) return "am";
  if (dayPart === TIMEOFF_DAY_PART.afternoon) return "pm";
  return "full";
}

/**
 * The OOOhm requests one TimeOff leave becomes, before day counting. OOOhm half days are
 * single-day requests, so a leave from a Monday afternoon to a Wednesday morning becomes
 * Monday (pm), Tuesday (full) and Wednesday (am). A single-day leave follows its start
 * day part, as TimeOff counts it. Ranges longer than OOOhm's longest request are cut into
 * consecutive pieces.
 */
export function leaveSegments(leave: Pick<TimeOffLeave, "dateStart" | "dateEnd" | "dayPartStart" | "dayPartEnd">): LeaveRange[] {
  if (leave.dateStart === leave.dateEnd) {
    return [{ startDate: leave.dateStart, endDate: leave.dateEnd, dayPortion: portionOf(leave.dayPartStart) }];
  }
  const first = toEpochDay(leave.dateStart);
  const last = toEpochDay(leave.dateEnd);
  const startHalf = portionOf(leave.dayPartStart);
  const endHalf = portionOf(leave.dayPartEnd);
  const out: LeaveRange[] = [];
  if (startHalf !== "full") out.push({ startDate: leave.dateStart, endDate: leave.dateStart, dayPortion: startHalf });
  const fullFrom = startHalf === "full" ? first : first + 1;
  const fullTo = endHalf === "full" ? last : last - 1;
  for (let from = fullFrom; from <= fullTo; from += MAX_REQUEST_SPAN_DAYS) {
    const to = Math.min(fullTo, from + MAX_REQUEST_SPAN_DAYS - 1);
    out.push({ startDate: fromEpochDay(from), endDate: fromEpochDay(to), dayPortion: "full" });
  }
  if (endHalf !== "full") out.push({ startDate: leave.dateEnd, endDate: leave.dateEnd, dayPortion: endHalf });
  return out;
}

function truncate(text: string | null, max: number): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i]);
}

/** Picks the account kept when several TimeOff users share an email: active, then most leave, then oldest. */
function keepOne(users: readonly TimeOffUser[], isActive: (u: TimeOffUser) => boolean, leaveCount: (id: number) => number): TimeOffUser {
  return [...users].sort(
    (a, b) => Number(isActive(b)) - Number(isActive(a)) || leaveCount(b.id) - leaveCount(a.id) || a.id - b.id,
  )[0];
}

/**
 * The TimeOff company to import: the one asked for, or the file's only one.
 *
 * @throws DomainError `import_refused` when there is none, or several and none was chosen.
 */
export function selectTimeOffCompany(snapshot: Pick<TimeOffSnapshot, "companies">, timeoffCompanyId?: number): TimeOffCompany {
  const found =
    timeoffCompanyId !== undefined
      ? snapshot.companies.find((c) => c.id === timeoffCompanyId)
      : snapshot.companies.length === 1
        ? snapshot.companies[0]
        : undefined;
  if (found) return found;
  const listed = snapshot.companies.map((c) => `${c.id} (${c.name})`).join(", ");
  return refuse(
    snapshot.companies.length === 0
      ? "The file holds no TimeOff company."
      : timeoffCompanyId !== undefined
        ? `The file has no TimeOff company ${timeoffCompanyId}. It has: ${listed}.`
        : `The file holds several TimeOff companies: ${listed}. Choose one with --timeoff-company <id>.`,
  );
}

/** TimeOff's time zone for the company, when OOOhm supports it. */
export function timeOffTimeZone(company: Pick<TimeOffCompany, "timezone">): string | null {
  return company.timezone && isSupportedTimeZone(company.timezone) ? company.timezone : null;
}

/**
 * Builds the import plan for one TimeOff company.
 *
 * @throws DomainError `import_refused` when the file holds no company, several companies
 *   and none was chosen, an unknown `poolTypeName`, or several `use_allowance` types
 *   without `mergePoolTypes`. The message names the option that resolves it.
 */
export function buildImportPlan(snapshot: TimeOffSnapshot, options: ImportPlanOptions): ImportPlan {
  const warnings: ImportIssue[] = [];
  const conflicts: ImportIssue[] = [];
  const warn = (issue: ImportIssue) => warnings.push(issue);

  // Company
  const company = selectTimeOffCompany(snapshot, options.timeoffCompanyId);
  const companySchedule = snapshot.schedules.find((s) => s.userId === null && s.companyId === company.id);
  let workingDays = companySchedule ? scheduleWorkingDays(companySchedule) : [...TIMEOFF_DEFAULT_WORKING_DAYS];
  if (workingDays.length === 0) {
    warn({ code: "company_schedule_empty", message: "TimeOff's company schedule has no working day; using Monday to Friday." });
    workingDays = [...TIMEOFF_DEFAULT_WORKING_DAYS];
  }
  const timezone = timeOffTimeZone(company);
  if (!timezone) {
    warn({ code: "timezone_unknown", message: `TimeOff's time zone "${company.timezone ?? ""}" is not one OOOhm knows; the company keeps its own.` });
  }
  if (company.startOfNewYear !== null && company.startOfNewYear !== 1) {
    warn({
      code: "start_of_year",
      message: `TimeOff's leave year is set to start in month ${company.startOfNewYear}; OOOhm's years start on Jan 1 (TimeOff's balances already use calendar years).`,
    });
  }
  const carryOver = Math.max(0, company.carryOver);
  const plannedCompany: PlannedCompany = {
    timeoffId: company.id,
    name: company.name,
    timezone,
    workingDays,
    carryoverEnabled: carryOver > 0,
    carryoverMaxDays: carryOver > UNLIMITED_CARRY_OVER ? null : carryOver > 0 ? carryOver : null,
  };

  const users = snapshot.users.filter((u) => u.companyId === company.id);
  const userIds = new Set(users.map((u) => u.id));
  const leaveTypes = snapshot.leaveTypes
    .filter((t) => t.companyId === company.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const typeById = new Map(leaveTypes.map((t) => [t.id, t]));
  const leaves = snapshot.leaves.filter((l) => userIds.has(l.userId));
  const leaveCount = new Map<number, number>();
  for (const l of leaves) leaveCount.set(l.userId, (leaveCount.get(l.userId) ?? 0) + 1);

  // Holidays
  const holidays: PlannedHoliday[] = [];
  const holidayDates = new Set<CalendarDate>();
  for (const h of snapshot.bankHolidays.filter((b) => b.companyId === company.id).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)) {
    if (!isCalendarDate(h.date)) {
      warn({ code: "holiday_invalid", message: `Bank holiday ${h.id} has no valid date; skipped.`, timeoffId: h.id });
      continue;
    }
    if (holidayDates.has(h.date)) {
      warn({ code: "holiday_duplicate", message: `Two bank holidays on ${h.date}; kept the first.`, timeoffId: h.id });
      continue;
    }
    holidayDates.add(h.date);
    let name: string;
    try {
      name = normalizeHolidayName(h.name);
    } catch {
      name = h.name.trim() ? h.name.trim().slice(0, 100) : "Holiday";
    }
    holidays.push({ date: h.date, name, timeoffId: h.id });
  }
  // OOOhm's side: the company calendar as it will be after the import.
  const ooohmHolidays = new Set<CalendarDate>([...holidayDates, ...(options.existingHolidays ?? [])]);
  const extraHolidays = [...ooohmHolidays].filter((d) => !holidayDates.has(d));
  const companyCalendar = { workingDays, holidays: ooohmHolidays };

  // Departments
  const departments: PlannedDepartment[] = [];
  const departmentKey = new Map<number, number>();
  const byName = new Map<string, number>();
  const sourceDepartments = snapshot.departments.filter((d) => d.companyId === company.id).sort((a, b) => a.id - b.id);
  for (const d of sourceDepartments) {
    let name: string;
    try {
      name = normalizeDepartmentName(d.name);
    } catch {
      name = `Department ${d.id}`;
    }
    const existing = byName.get(name.toLowerCase());
    if (existing !== undefined) {
      departmentKey.set(d.id, existing);
      warn({ code: "department_duplicate", message: `Departments ${existing} and ${d.id} are both named "${name}"; they become one.`, timeoffId: d.id });
    } else {
      byName.set(name.toLowerCase(), d.id);
      departmentKey.set(d.id, d.id);
      departments.push({ key: d.id, name });
    }
    if (!d.includePublicHolidays) {
      warn({ code: "department_hides_holidays", message: `"${name}" hides bank holidays on TimeOff's calendar; OOOhm shows company holidays to everyone.`, timeoffId: d.id });
    }
    if (d.isAccruedAllowance) {
      warn({
        code: "accrued_allowance",
        message: `"${name}" uses accrued allowance in TimeOff (only days earned so far are available). OOOhm grants the full year; balances are compared on the full-year figure.`,
        timeoffId: d.id,
      });
    }
  }
  const departmentById = new Map(sourceDepartments.map((d) => [d.id, d]));
  if (snapshot.departmentSupervisorLinks > 0) {
    warn({
      code: "department_supervisors",
      message: `${snapshot.departmentSupervisorLinks} extra department supervisor link(s) were not imported: OOOhm has one approver per person (their manager, else an admin).`,
    });
  }

  // People
  // TimeOff decides employment from `end_date` alone (still employed while it is in the
  // future). Its `activated` flag only records that the account has signed in once.
  const timeoffActive = (u: TimeOffUser) => u.endDate === null || u.endDate > options.today;
  const groups = new Map<string, TimeOffUser[]>();
  let skippedUsers = 0;
  for (const u of users) {
    let email: string;
    try {
      email = normalizeEmail(u.email);
    } catch {
      conflicts.push({ code: "invalid_email", message: `TimeOff user ${u.id} has an email OOOhm cannot use ("${u.email}"); not imported.`, timeoffId: u.id });
      skippedUsers++;
      continue;
    }
    groups.set(email, [...(groups.get(email) ?? []), u]);
  }
  const personOf = new Map<number, number>();
  const kept: { user: TimeOffUser; email: string }[] = [];
  for (const [email, group] of groups) {
    const keep = keepOne(group, timeoffActive, (id) => leaveCount.get(id) ?? 0);
    for (const u of group) personOf.set(u.id, keep.id);
    kept.push({ user: keep, email });
    for (const other of group.filter((u) => u.id !== keep.id)) {
      skippedUsers++;
      conflicts.push({
        code: "duplicate_email",
        email,
        timeoffId: other.id,
        message: `TimeOff users ${keep.id} and ${other.id} share the email ${email} (ignoring case). Imported ${keep.id}; ${other.id} and its ${leaveCount.get(other.id) ?? 0} leave(s) were not imported.`,
      });
    }
  }
  kept.sort((a, b) => a.user.id - b.user.id);
  const keptIds = new Set(kept.map((k) => k.user.id));

  const managerOf = new Map<number, number | null>();
  for (const { user: u, email } of kept) {
    const dept = u.departmentId !== null ? departmentById.get(u.departmentId) : undefined;
    const boss = dept?.bossId != null ? personOf.get(dept.bossId) : undefined;
    if (dept?.bossId != null && boss === undefined) {
      warn({ code: "boss_missing", email, message: `${email}'s department boss (TimeOff user ${dept.bossId}) was not imported; an admin approves their leave.` });
    }
    managerOf.set(u.id, boss !== undefined && boss !== u.id ? boss : null);
  }
  // A manager chain that loops back (A's boss is B, B's is A) would make approvals circular.
  for (const { user: u, email } of kept) {
    const seen = new Set<number>([u.id]);
    for (let m = managerOf.get(u.id) ?? null; m !== null; m = managerOf.get(m) ?? null) {
      if (seen.has(m)) {
        if (m === u.id) {
          managerOf.set(u.id, null);
          warn({ code: "manager_cycle", email, message: `${email}'s managers form a loop through their departments; ${email} was left without a manager (an admin approves).` });
        }
        break;
      }
      seen.add(m);
    }
  }
  const managers = new Set([...managerOf.values()].filter((m): m is number => m !== null));

  const people: PlannedPerson[] = kept.map(({ user: u, email }) => {
    let name: string;
    try {
      name = normalizePersonName(`${u.name} ${u.lastname}`);
    } catch {
      name = email.split("@")[0].slice(0, PERSON_NAME_MAX_LENGTH);
    }
    const isActive = timeoffActive(u);
    if (!u.activated && isActive) {
      warn({ code: "never_signed_in", email, message: `${email} never signed in to TimeOff; imported as active, like any current employee.` });
    }
    const departmentId = u.departmentId !== null ? (departmentKey.get(u.departmentId) ?? null) : null;
    // Midday UTC, so the date is the same in every company time zone the rollover reads it in.
    const startedBy = u.startDate !== null && u.startDate <= options.today ? `${u.startDate}T12:00:00.000Z` : null;
    // Someone not started yet joined (for the rollover) no earlier than this year: they carry nothing into it.
    const notStartedYet = u.startDate !== null && u.startDate > options.today;
    return {
      key: u.id,
      email,
      name,
      role: u.admin ? "admin" : managers.has(u.id) ? "manager" : "employee",
      departmentKey: departmentId,
      managerKey: managerOf.get(u.id) ?? null,
      canSelfApprove: u.autoApprove,
      isActive,
      createdAt: startedBy ?? (notStartedYet || !u.createdAt ? `${options.today}T12:00:00.000Z` : u.createdAt),
    };
  });

  // Leave types
  const typeName = (t: TimeOffLeaveType) => t.name.replace(/\s+/g, " ").trim().slice(0, LEAVE_TYPE_NAME_MAX_LENGTH) || `Type ${t.id}`;
  const poolCandidates = leaveTypes.filter((t) => t.useAllowance);
  let poolSource: TimeOffLeaveType | undefined;
  if (options.poolTypeName !== undefined) {
    const wanted = options.poolTypeName.trim().toLowerCase();
    poolSource = poolCandidates.find((t) => t.name.trim().toLowerCase() === wanted);
    if (!poolSource) {
      refuse(
        `--pool-type "${options.poolTypeName}" is not a TimeOff leave type that uses the allowance. Those are: ${
          poolCandidates.map((t) => `"${t.name}"`).join(", ") || "none"
        }.`,
      );
    }
  } else {
    poolSource = poolCandidates[0];
  }
  if (poolCandidates.length > 1 && !options.mergePoolTypes) {
    refuse(
      `${poolCandidates.length} TimeOff leave types share the allowance pool: ${poolCandidates.map((t) => `"${t.name}"`).join(", ")}. ` +
        `OOOhm keeps an allowance per leave type, so one balance needs one type. Pass --merge-pool-types to import them all as ` +
        `"${poolSource!.name}" (each request keeps its original type name in its note), and --pool-type "<name>" to choose which name the merged type takes. ` +
        `Or, in TimeOff, turn "use allowance" off for the types that should not count, then export again.`,
    );
  }
  if (!poolSource) {
    warn({ code: "no_pool", message: "No TimeOff leave type uses the allowance: every type imports untracked and no allowance is imported." });
  }
  const poolIds = new Set(poolCandidates.map((t) => t.id));
  // People invited after the import get the pool type's default allowance. TimeOff's
  // allowance is per department, so there is one figure to default to only when every
  // department has the same; imported people always get explicit rows either way.
  const departmentAllowances = [...new Set(sourceDepartments.map((d) => d.allowance))].sort((a, b) => a - b);
  const poolDefault =
    departmentAllowances.length === 1 && departmentAllowances[0] >= 0 && departmentAllowances[0] <= MAX_ALLOWANCE_DAYS ? departmentAllowances[0] : null;
  if (poolSource && poolDefault === null) {
    warn({
      code: "pool_type_no_default",
      message:
        `"${typeName(poolSource)}" gets no default allowance, because TimeOff's departments have different allowances ` +
        `(${departmentAllowances.join(", ") || "none"} days). Everyone imported has their own allowance, but anyone invited later ` +
        `would have unlimited, untracked "${typeName(poolSource)}" until an admin sets a default under Leave types or gives them an allowance.`,
    });
  }

  const codes = new Set<string>();
  const plannedTypes: PlannedLeaveType[] = [];
  const typeKeyOf = new Map<number, string>();
  const badColors: string[] = [];
  const colorFor = (t: TimeOffLeaveType, index: number) => {
    try {
      return normalizeLeaveTypeColor(t.color);
    } catch {
      badColors.push(t.name);
      return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
    }
  };
  // The pool type leads (the request form preselects the first type); the rest keep TimeOff's order.
  const ordered = [...leaveTypes.entries()].sort(([, a], [, b]) => Number(b.id === poolSource?.id) - Number(a.id === poolSource?.id));
  for (const [index, t] of ordered) {
    if (poolIds.has(t.id) && t.id !== poolSource!.id) continue;
    const key = leaveTypeCodeFor(t.name, codes);
    codes.add(key);
    if (t.id === poolSource?.id) {
      plannedTypes.push({
        key,
        name: typeName(t),
        color: colorFor(t, index),
        countsAgainstAllowance: true,
        defaultAllowanceDays: poolDefault,
        carryoverEnabled: plannedCompany.carryoverEnabled,
        carryoverMaxDays: plannedCompany.carryoverMaxDays,
        sortOrder: plannedTypes.length,
        pool: true,
        timeoffTypeIds: poolCandidates.map((p) => p.id),
      });
      for (const p of poolCandidates) typeKeyOf.set(p.id, key);
    } else {
      const limit = t.limit > 0 ? Math.min(t.limit, MAX_ALLOWANCE_DAYS) : null;
      plannedTypes.push({
        key,
        name: typeName(t),
        color: colorFor(t, index),
        countsAgainstAllowance: limit !== null,
        defaultAllowanceDays: limit,
        carryoverEnabled: false,
        carryoverMaxDays: null,
        sortOrder: plannedTypes.length,
        pool: false,
        timeoffTypeIds: [t.id],
      });
      typeKeyOf.set(t.id, key);
    }
  }
  for (const t of poolCandidates.filter((p) => p.limit > 0)) {
    warn({ code: "pool_type_limit", message: `"${t.name}" has a yearly limit of ${t.limit} in TimeOff on top of the shared allowance; OOOhm keeps only the allowance for it.`, timeoffId: t.id });
  }
  for (const t of leaveTypes.filter((lt) => lt.autoApprove)) {
    warn({ code: "type_auto_approve", message: `"${t.name}" is approved automatically in TimeOff; OOOhm approves automatically per person (self-approval), not per type.`, timeoffId: t.id });
  }
  if (badColors.length > 0) {
    warn({ code: "type_color", message: `Leave type colours that are not hex values got a default colour: ${badColors.map((n) => `"${n}"`).join(", ")}.` });
  }
  const poolKey = poolSource ? typeKeyOf.get(poolSource.id)! : null;

  // Working calendars per person
  const calendarOf = new Map<number, TimeOffWorkCalendar>();
  const ownSchedule = new Set<number>();
  for (const { user: u, email } of kept) {
    const own = snapshot.schedules.find((s) => s.userId === u.id);
    const days = own ? scheduleWorkingDays(own) : workingDays;
    if (own && !sameDays(days, workingDays)) {
      ownSchedule.add(u.id);
      warn({
        code: "personal_schedule",
        email,
        message: `${email} has their own TimeOff schedule (ISO weekdays ${days.join(",") || "none"}); OOOhm counts the company's working days (${workingDays.join(",")}) for everyone.`,
      });
    }
    calendarOf.set(u.id, { workingDays: new Set(days), holidays: holidayDates });
  }
  const companyWork: TimeOffWorkCalendar = { workingDays: new Set(workingDays), holidays: holidayDates };

  // Leave
  const requests: PlannedRequest[] = [];
  const differences: LeaveCostDifference[] = [];
  let skippedLeaves = 0;
  const pended: number[] = [];
  const poolLeavesOf = new Map<number, TimeOffLeave[]>();
  for (const leave of [...leaves].sort((a, b) => a.dateStart.localeCompare(b.dateStart) || a.id - b.id)) {
    if (!keptIds.has(leave.userId)) {
      skippedLeaves++;
      continue;
    }
    const type = typeById.get(leave.leaveTypeId);
    const status = STATUS_MAP[leave.status];
    if (!type || !status || !isCalendarDate(leave.dateStart) || !isCalendarDate(leave.dateEnd) || leave.dateEnd < leave.dateStart) {
      skippedLeaves++;
      warn({
        code: "leave_invalid",
        timeoffId: leave.id,
        message: `Leave ${leave.id} has ${!type ? "an unknown leave type" : !status ? `an unknown status (${leave.status})` : "invalid dates"}; skipped.`,
      });
      continue;
    }
    const pooled = poolIds.has(type.id);
    if (pooled) poolLeavesOf.set(leave.userId, [...(poolLeavesOf.get(leave.userId) ?? []), leave]);
    if (leave.status === TIMEOFF_STATUS.pendedRevoke) pended.push(leave.id);

    const parts = leaveSegments(leave).flatMap((range) => {
      const split = splitLeaveDaysByYear(range, companyCalendar);
      return split.length === 0 ? [] : [{ range, split, days: split.reduce((sum, s) => addDays(sum, s.days), 0) }];
    });

    if (pooled && isTimeOffApproved(leave.status)) {
      const years = new Set([yearOf(leave.dateStart), yearOf(leave.dateEnd)]);
      for (let y = yearOf(leave.dateStart); y <= yearOf(leave.dateEnd); y++) years.add(y);
      for (const year of years) {
        const timeoff = timeOffDeductedDays(leave, calendarOf.get(leave.userId)!, year);
        const ooohm = parts.reduce((sum, p) => addDays(sum, p.split.find((s) => s.year === year)?.days ?? 0), 0);
        if (timeoff === ooohm) continue;
        const reason =
          ownSchedule.has(leave.userId) && timeOffDeductedDays(leave, companyWork, year) === ooohm
            ? "personal_schedule"
            : extraHolidays.length > 0 && timeOffDeductedDays(leave, calendarOf.get(leave.userId)!, year) !== timeOffDeductedDays(leave, { ...calendarOf.get(leave.userId)!, holidays: ooohmHolidays }, year)
              ? "company_holiday"
              : "half_day_rule";
        differences.push({ personKey: leave.userId, timeoffLeaveId: leave.id, year, timeoff, ooohm, reason });
      }
    }

    if (parts.length === 0) {
      skippedLeaves++;
      if (status === "approved" || status === "pending") {
        warn({ code: "leave_zero_days", timeoffId: leave.id, message: `Leave ${leave.id} (${leave.dateStart} to ${leave.dateEnd}) falls only on weekends or holidays; nothing to import.` });
      }
      continue;
    }
    const prefix = pooled && type.id !== poolSource!.id ? `[TimeOff: ${typeName(type)}] ` : "";
    const comment = truncate(leave.employeeComment, NOTE_MAX_LENGTH - prefix.length);
    const note = prefix || comment ? `${prefix}${comment ?? ""}`.trim() : null;
    const approver = leave.approverId !== null ? (personOf.get(leave.approverId) ?? null) : null;
    for (const [i, p] of parts.entries()) {
      requests.push({
        personKey: leave.userId,
        leaveTypeKey: typeKeyOf.get(type.id)!,
        timeoffLeaveId: leave.id,
        part: i + 1,
        parts: parts.length,
        startDate: p.range.startDate,
        endDate: p.range.endDate,
        dayPortion: p.range.dayPortion,
        days: p.days,
        split: p.split,
        status,
        approverKey: approver !== null && keptIds.has(approver) ? approver : null,
        note,
        decisionNote: truncate(leave.approverComment, NOTE_MAX_LENGTH),
        createdAt: leave.createdAt,
        decidedAt: status === "pending" ? null : leave.decidedAt,
      });
    }
  }
  if (pended.length > 0) {
    warn({
      code: "pended_revoke",
      message: `${pended.length} leave(s) were waiting for a revoke decision in TimeOff (ids ${pended.join(", ")}). TimeOff still counts them as taken, so they import as approved; cancel them in OOOhm if the revoke should go ahead.`,
    });
  }

  // Allowances and TimeOff's balances
  const allowances: PlannedAllowance[] = [];
  const expected: ExpectedBalance[] = [];
  const adjustmentOf = new Map(snapshot.adjustments.map((a) => [`${a.userId}|${a.year}`, a]));
  if (poolKey !== null) {
    for (const { user: u, email } of kept) {
      const person = people.find((p) => p.key === u.id)!;
      const poolLeaves = poolLeavesOf.get(u.id) ?? [];
      const years = new Set<number>();
      for (const l of poolLeaves) for (let y = yearOf(l.dateStart); y <= yearOf(l.dateEnd); y++) years.add(y);
      for (const a of snapshot.adjustments) if (a.userId === u.id) years.add(a.year);
      const startYear = u.startDate !== null ? yearOf(u.startDate) : null;
      if (person.isActive) {
        years.add(options.currentYear);
        // A future hire needs a row up to their start year, or the pool type would be untracked for them.
        if (startYear !== null && startYear > options.currentYear) years.add(startYear);
        // With a default, the rollover reads a missing closing year as the default, which is
        // not TimeOff's figure in a start year: give that year a row of its own.
        if (poolDefault !== null && (startYear === null || startYear < options.currentYear)) years.add(options.currentYear - 1);
      }
      if (years.size === 0) continue;

      const dept = u.departmentId !== null ? departmentById.get(u.departmentId) : undefined;
      if (!dept) warn({ code: "no_department", email, message: `${email} has no department in TimeOff, so no allowance (0 days).` });
      const nominal = dept?.allowance ?? 0;
      if (nominal < 0 || nominal > MAX_ALLOWANCE_DAYS) refuse(`Department "${dept?.name}" has an allowance of ${nominal} days; OOOhm allows 0 to ${MAX_ALLOWANCE_DAYS}.`);
      let lo = Math.min(...years);
      let hi = Math.max(...years);
      // Years before the start get no row, except from the current year on for a future
      // hire: those get a zero row (TimeOff shows 0 before someone starts).
      if (startYear !== null) lo = Math.max(lo, Math.min(startYear, options.currentYear));
      if (u.endDate !== null) hi = Math.min(hi, yearOf(u.endDate));
      const allowanceYears = new Set<number>();
      for (let year = lo; year <= hi; year++) allowanceYears.add(year);

      for (const year of [...new Set([...allowanceYears, ...years])].sort((a, b) => a - b)) {
        const adj = adjustmentOf.get(`${u.id}|${year}`);
        const used = poolLeaves
          .filter((l) => isTimeOffApproved(l.status))
          .reduce((sum, l) => addDays(sum, timeOffDeductedDays(l, calendarOf.get(u.id)!, year)), 0);
        const timeoff = timeOffYearBalance({
          year,
          nominal,
          startDate: u.startDate,
          endDate: u.endDate,
          adjustment: adj?.adjustment ?? 0,
          carriedOver: adj?.carriedOverAllowance ?? 0,
          used,
        });
        expected.push({ personKey: u.id, year, timeoff });
        if (!allowanceYears.has(year)) continue;
        if (timeoff.beforeStart) {
          allowances.push({
            personKey: u.id,
            leaveTypeKey: poolKey,
            year,
            days: nominal,
            adjustmentDays: -nominal || 0,
            carriedOverDays: 0,
            timeoffAdjustment: 0,
            employmentAdjustment: -nominal || 0,
          });
          continue;
        }
        const adjustmentDays = addDays(timeoff.adjustment, timeoff.employmentAdjustment);
        for (const [what, value] of [["adjustment", adjustmentDays], ["carried-over allowance", timeoff.carriedOver]] as const) {
          if (Math.abs(value) > MAX_ALLOWANCE_DAYS) refuse(`${email}'s ${what} for ${year} is ${value} days; OOOhm allows at most ${MAX_ALLOWANCE_DAYS}.`);
        }
        allowances.push({
          personKey: u.id,
          leaveTypeKey: poolKey,
          year,
          days: nominal,
          adjustmentDays,
          carriedOverDays: timeoff.carriedOver,
          timeoffAdjustment: timeoff.adjustment,
          employmentAdjustment: timeoff.employmentAdjustment,
        });
      }
    }
  }

  return {
    company: plannedCompany,
    departments,
    people,
    leaveTypes: plannedTypes,
    poolTypeKey: poolKey,
    holidays,
    allowances,
    requests,
    expected,
    leaveCostDifferences: differences,
    warnings,
    conflicts,
    skipped: { users: skippedUsers, leaves: skippedLeaves },
  };
}

/** Whether `err` is the planner's refusal (as opposed to a bug). */
export function isImportRefusal(err: unknown): err is DomainError {
  return isDomainError(err, "import_refused");
}

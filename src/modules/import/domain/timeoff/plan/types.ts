/**
 * The shapes of a TimeOff import plan: what the planner returns and the import writes,
 * and what its steps hand each other.
 */
import type { Role } from "@/domain/actor";
import type { CalendarDate } from "@/domain/calendar-date";
import type { YearDays } from "@/domain/leave-days";
import type { DayPortion, LeaveStatus } from "@/domain/leave-request";
import type { TimeOffYearBalance } from "../balance";
import type { TimeOffCompany, TimeOffLeave, TimeOffLeaveType, TimeOffUser } from "../source";

/** Records a warning for the report. */
export type Warn = (issue: ImportIssue) => void;

/** The parts of the snapshot that belong to the TimeOff company being imported. */
export interface CompanyScope {
  company: TimeOffCompany;
  users: TimeOffUser[];
  /** By sort order, then id. */
  leaveTypes: TimeOffLeaveType[];
  typeById: ReadonlyMap<number, TimeOffLeaveType>;
  leaves: TimeOffLeave[];
  /** Leaves per TimeOff user id. */
  leaveCount: ReadonlyMap<number, number>;
}

/** A TimeOff user kept for an email (one per email). */
export interface KeptUser {
  user: TimeOffUser;
  email: string;
}

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

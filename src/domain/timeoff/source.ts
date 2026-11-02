/**
 * TimeOff.Management's data, as plain typed records.
 *
 * OOOhm replaces TimeOff.Management. These types describe its **data layout** only (the
 * tables of its SQLite database: `Companies`, `Departments`, `Users`, `LeaveTypes`,
 * `Leaves`, `BankHolidays`, `user_allowance_adjustment`, `schedule`), so the importer can
 * read a TimeOff file and the balance rules can be checked against it. No TimeOff code is
 * used: the reader (`src/server/importers/timeoff`) fills these records, and everything
 * else works on them.
 *
 * Dates are `YYYY-MM-DD` (TimeOff stores date-times at UTC midnight); timestamps are ISO
 * strings or `null` when the file has none.
 */
import type { CalendarDate } from "@/domain/calendar-date";

/** `Leaves.status`. */
export const TIMEOFF_STATUS = {
  new: 1,
  approved: 2,
  rejected: 3,
  pendedRevoke: 4,
  canceled: 5,
} as const;

/** `Leaves.day_part_start` / `day_part_end`. */
export const TIMEOFF_DAY_PART = {
  allDay: 1,
  morning: 2,
  afternoon: 3,
} as const;

/** `schedule.<weekday>`: 1 is a full working day; 2 (no work), 3 and 4 (half days) are not. */
export const TIMEOFF_SCHEDULE_WORKING_DAY = 1;

export interface TimeOffCompany {
  id: number;
  name: string;
  country: string | null;
  /** IANA zone; TimeOff's default is Europe/London. */
  timezone: string | null;
  /** First month of the leave year. TimeOff's own balance code uses calendar years regardless. */
  startOfNewYear: number | null;
  /** Most days carried into the next year; 0 = carryover off. */
  carryOver: number;
}

export interface TimeOffDepartment {
  id: number;
  companyId: number;
  name: string;
  /** Yearly allowance of everyone in the department (TimeOff's only allowance source). */
  allowance: number;
  bossId: number | null;
  includePublicHolidays: boolean;
  isAccruedAllowance: boolean;
}

export interface TimeOffUser {
  id: number;
  companyId: number;
  departmentId: number | null;
  email: string;
  name: string;
  lastname: string;
  admin: boolean;
  activated: boolean;
  autoApprove: boolean;
  startDate: CalendarDate | null;
  /** Last day of employment; a user is active while this is empty or not yet past. */
  endDate: CalendarDate | null;
  createdAt: string | null;
}

export interface TimeOffLeaveType {
  id: number;
  companyId: number;
  name: string;
  color: string;
  /** Leave of this type is taken from the person's one shared allowance pool. */
  useAllowance: boolean;
  /** Most days of this type a year, on top of the pool rule; 0 = no limit. */
  limit: number;
  sortOrder: number;
  autoApprove: boolean;
}

export interface TimeOffLeave {
  id: number;
  userId: number;
  approverId: number | null;
  leaveTypeId: number;
  /** One of {@link TIMEOFF_STATUS}. */
  status: number;
  dateStart: CalendarDate;
  dateEnd: CalendarDate;
  /** One of {@link TIMEOFF_DAY_PART}. */
  dayPartStart: number;
  dayPartEnd: number;
  employeeComment: string | null;
  approverComment: string | null;
  createdAt: string | null;
  decidedAt: string | null;
}

export interface TimeOffBankHoliday {
  id: number;
  companyId: number;
  name: string;
  date: CalendarDate;
}

/** `user_allowance_adjustment`: one row per person and year. */
export interface TimeOffAdjustment {
  userId: number;
  year: number;
  adjustment: number;
  carriedOverAllowance: number;
}

/** `schedule`: a company's working week, or one person's own. */
export interface TimeOffSchedule {
  companyId: number | null;
  userId: number | null;
  /** Monday first: the stored value for each weekday (see {@link TIMEOFF_SCHEDULE_WORKING_DAY}). */
  days: readonly [number, number, number, number, number, number, number];
}

/** Everything the importer reads from one TimeOff file. */
export interface TimeOffSnapshot {
  companies: TimeOffCompany[];
  departments: TimeOffDepartment[];
  users: TimeOffUser[];
  leaveTypes: TimeOffLeaveType[];
  leaves: TimeOffLeave[];
  bankHolidays: TimeOffBankHoliday[];
  adjustments: TimeOffAdjustment[];
  schedules: TimeOffSchedule[];
  /** Rows linking extra supervisors to departments; OOOhm has one approver per person. */
  departmentSupervisorLinks: number;
}

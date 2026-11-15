/**
 * The small rules every planning step shares: status and day-part mapping, leave type
 * codes and names, segments of a leave, and which TimeOff company is imported.
 */
import { type CalendarDate, fromEpochDay, toEpochDay } from "@/domain/calendar-date";
import { isSupportedTimeZone } from "@/domain/company-settings";
import { DomainError } from "@/domain/errors";
import { type DayPortion, type LeaveRange, type LeaveStatus, MAX_REQUEST_SPAN_DAYS } from "@/domain/leave-request";
import { LEAVE_TYPE_CODE_MAX_LENGTH, LEAVE_TYPE_NAME_MAX_LENGTH, MAX_ALLOWANCE_DAYS } from "@/domain/leave-type-settings";
import { oneLine } from "@/domain/text";
import { TIMEOFF_DAY_PART, TIMEOFF_STATUS, type TimeOffCompany, type TimeOffLeave, type TimeOffLeaveType, type TimeOffSnapshot, type TimeOffUser } from "../source";


export const STATUS_MAP: Readonly<Record<number, LeaveStatus>> = {
  [TIMEOFF_STATUS.new]: "pending",
  [TIMEOFF_STATUS.approved]: "approved",
  [TIMEOFF_STATUS.rejected]: "rejected",
  [TIMEOFF_STATUS.pendedRevoke]: "approved",
  [TIMEOFF_STATUS.canceled]: "cancelled",
};

/** Colours for TimeOff types whose colour is not a hex value (older files store CSS class names). */
export const FALLBACK_COLORS = ["#0f766e", "#b45309", "#be123c", "#7c3aed", "#1d4ed8", "#4d7c0f", "#6b7280"];

/** TimeOff offers "all days" as a very large carry-over number; beyond a year of days it means no cap. */
export const UNLIMITED_CARRY_OVER = MAX_ALLOWANCE_DAYS;

export const yearOf = (date: CalendarDate) => Number(date.slice(0, 4));
export const refuse = (message: string): never => {
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
export function portionOf(dayPart: number): DayPortion {
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

export function truncate(text: string | null, max: number): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function sameDays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i]);
}

/** Picks the account kept when several TimeOff users share an email: active, then most leave, then oldest. */
export function keepOne(users: readonly TimeOffUser[], isActive: (u: TimeOffUser) => boolean, leaveCount: (id: number) => number): TimeOffUser {
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

/** A TimeOff type's name as an OOOhm leave type name: one line, at most the name limit, never blank. */
export function typeName(t: Pick<TimeOffLeaveType, "id" | "name">): string {
  return oneLine(t.name).slice(0, LEAVE_TYPE_NAME_MAX_LENGTH) || `Type ${t.id}`;
}


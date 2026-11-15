/**
 * Planning step: TimeOff's leaves as OOOhm requests, and where OOOhm counts a pooled
 * leave differently from TimeOff.
 */
import { addDays } from "@/domain/allowance-policy";
import type { CalendarDate } from "@/domain/calendar-date";
import { isCalendarDate } from "@/domain/calendar-date";
import { splitLeaveDaysByYear, type YearDays } from "@/shared/kernel/leave-days";
import { type LeaveRange, type LeaveStatus, NOTE_MAX_LENGTH } from "@/shared/kernel/leave-range";
import { isTimeOffApproved, timeOffDeductedDays } from "../balance";
import { TIMEOFF_STATUS, type TimeOffLeave, type TimeOffLeaveType } from "../source";
import type { CalendarPlan } from "./calendars";
import { leaveSegments, STATUS_MAP, truncate, typeName, yearOf } from "./rules";
import type { CompanyScope, LeaveCostDifference, PlannedRequest, Warn } from "./types";

export interface RequestContext {
  scope: CompanyScope;
  keptIds: ReadonlySet<number>;
  personOf: ReadonlyMap<number, number>;
  typeKeyOf: ReadonlyMap<number, string>;
  poolIds: ReadonlySet<number>;
  poolSource: TimeOffLeaveType | undefined;
  calendars: CalendarPlan;
  /** The company calendar after the import, which OOOhm counts against. */
  companyCalendar: { workingDays: readonly number[]; holidays: ReadonlySet<CalendarDate> };
  /** TimeOff's holidays plus the target company's own; and the dates only OOOhm has. */
  ooohmHolidays: ReadonlySet<CalendarDate>;
  extraHolidays: readonly CalendarDate[];
}

export interface RequestPlan {
  requests: PlannedRequest[];
  differences: LeaveCostDifference[];
  skippedLeaves: number;
  /** TimeOff user id → their leaves of a pool type. */
  poolLeavesOf: Map<number, TimeOffLeave[]>;
}

/** A leave's OOOhm pieces (see `leaveSegments`) with their day counts, leaving out those that count no day. */
export interface LeavePart {
  range: LeaveRange;
  split: YearDays[];
  days: number;
}

export function leaveParts(leave: TimeOffLeave, companyCalendar: RequestContext["companyCalendar"]): LeavePart[] {
  return leaveSegments(leave).flatMap((range) => {
    const split = splitLeaveDaysByYear(range, companyCalendar);
    return split.length === 0 ? [] : [{ range, split, days: split.reduce((sum, s) => addDays(sum, s.days), 0) }];
  });
}

/** Every year a pooled, approved leave takes days from in which OOOhm's count differs from TimeOff's, and why. */
export function costDifferences(leave: TimeOffLeave, parts: readonly LeavePart[], c: RequestContext): LeaveCostDifference[] {
  const years = new Set([yearOf(leave.dateStart), yearOf(leave.dateEnd)]);
  for (let y = yearOf(leave.dateStart); y <= yearOf(leave.dateEnd); y++) years.add(y);
  const own = c.calendars.calendarOf.get(leave.userId)!;
  const out: LeaveCostDifference[] = [];
  for (const year of years) {
    const timeoff = timeOffDeductedDays(leave, own, year);
    const ooohm = parts.reduce((sum, p) => addDays(sum, p.split.find((s) => s.year === year)?.days ?? 0), 0);
    if (timeoff === ooohm) continue;
    const reason =
      c.calendars.ownSchedule.has(leave.userId) && timeOffDeductedDays(leave, c.calendars.companyWork, year) === ooohm
        ? "personal_schedule"
        : c.extraHolidays.length > 0 && timeOffDeductedDays(leave, own, year) !== timeOffDeductedDays(leave, { ...own, holidays: c.ooohmHolidays }, year)
          ? "company_holiday"
          : "half_day_rule";
    out.push({ personKey: leave.userId, timeoffLeaveId: leave.id, year, timeoff, ooohm, reason });
  }
  return out;
}

/** Why a leave cannot be imported at all, or `null`. */
function invalidLeave(leave: TimeOffLeave, type: TimeOffLeaveType | undefined, status: LeaveStatus | undefined): string | null {
  if (type && status && isCalendarDate(leave.dateStart) && isCalendarDate(leave.dateEnd) && leave.dateEnd >= leave.dateStart) return null;
  return !type ? "an unknown leave type" : !status ? `an unknown status (${leave.status})` : "invalid dates";
}

/** The OOOhm requests of one leave, one per part. A pooled leave of another type than the pool's keeps its type name in the note. */
export function requestsOf(leave: TimeOffLeave, type: TimeOffLeaveType, status: LeaveStatus, parts: readonly LeavePart[], c: RequestContext): PlannedRequest[] {
  const prefix = c.poolIds.has(type.id) && type.id !== c.poolSource!.id ? `[TimeOff: ${typeName(type)}] ` : "";
  const comment = truncate(leave.employeeComment, NOTE_MAX_LENGTH - prefix.length);
  const note = prefix || comment ? `${prefix}${comment ?? ""}`.trim() : null;
  const approver = leave.approverId !== null ? (c.personOf.get(leave.approverId) ?? null) : null;
  return parts.map((p, i) => ({
    personKey: leave.userId,
    leaveTypeKey: c.typeKeyOf.get(type.id)!,
    timeoffLeaveId: leave.id,
    part: i + 1,
    parts: parts.length,
    startDate: p.range.startDate,
    endDate: p.range.endDate,
    dayPortion: p.range.dayPortion,
    days: p.days,
    split: p.split,
    status,
    approverKey: approver !== null && c.keptIds.has(approver) ? approver : null,
    note,
    decisionNote: truncate(leave.approverComment, NOTE_MAX_LENGTH),
    createdAt: leave.createdAt,
    decidedAt: status === "pending" ? null : leave.decidedAt,
  }));
}

/** Every leave of a kept person, by start date, as requests; skipped ones are counted (and warned about when it matters). */
export function planRequests(c: RequestContext, warn: Warn): RequestPlan {
  const out: RequestPlan = { requests: [], differences: [], skippedLeaves: 0, poolLeavesOf: new Map() };
  const pended: number[] = [];
  for (const leave of [...c.scope.leaves].sort((a, b) => a.dateStart.localeCompare(b.dateStart) || a.id - b.id)) {
    if (!c.keptIds.has(leave.userId)) {
      out.skippedLeaves++;
      continue;
    }
    const type = c.scope.typeById.get(leave.leaveTypeId);
    const status = STATUS_MAP[leave.status];
    const invalid = invalidLeave(leave, type, status);
    if (invalid !== null || !type || !status) {
      out.skippedLeaves++;
      warn({ code: "leave_invalid", timeoffId: leave.id, message: `Leave ${leave.id} has ${invalid}; skipped.` });
      continue;
    }
    const pooled = c.poolIds.has(type.id);
    if (pooled) out.poolLeavesOf.set(leave.userId, [...(out.poolLeavesOf.get(leave.userId) ?? []), leave]);
    if (leave.status === TIMEOFF_STATUS.pendedRevoke) pended.push(leave.id);
    const parts = leaveParts(leave, c.companyCalendar);
    if (pooled && isTimeOffApproved(leave.status)) out.differences.push(...costDifferences(leave, parts, c));
    if (parts.length === 0) {
      out.skippedLeaves++;
      if (status === "approved" || status === "pending") {
        warn({ code: "leave_zero_days", timeoffId: leave.id, message: `Leave ${leave.id} (${leave.dateStart} to ${leave.dateEnd}) falls only on weekends or holidays; nothing to import.` });
      }
      continue;
    }
    out.requests.push(...requestsOf(leave, type, status, parts, c));
  }
  warnPendedRevokes(pended, warn);
  return out;
}

function warnPendedRevokes(pended: readonly number[], warn: Warn): void {
  if (pended.length === 0) return;
  warn({
    code: "pended_revoke",
    message: `${pended.length} leave(s) were waiting for a revoke decision in TimeOff (ids ${pended.join(", ")}). TimeOff still counts them as taken, so they import as approved; cancel them in OOOhm if the revoke should go ahead.`,
  });
}

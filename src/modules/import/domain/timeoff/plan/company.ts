/**
 * Planning step: the company itself (schedule, time zone, carryover) and the parts of
 * the snapshot that belong to it.
 */
import { scheduleWorkingDays, TIMEOFF_DEFAULT_WORKING_DAYS } from "../balance";
import type { TimeOffCompany, TimeOffSnapshot } from "../source";
import { timeOffTimeZone, UNLIMITED_CARRY_OVER } from "./rules";
import type { CompanyScope, PlannedCompany, Warn } from "./types";

/** The users, leave types (by sort order) and leaves of `company`, and each user's leave count. */
export function companyScope(snapshot: TimeOffSnapshot, company: TimeOffCompany): CompanyScope {
  const users = snapshot.users.filter((u) => u.companyId === company.id);
  const userIds = new Set(users.map((u) => u.id));
  const leaveTypes = snapshot.leaveTypes
    .filter((t) => t.companyId === company.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const leaves = snapshot.leaves.filter((l) => userIds.has(l.userId));
  const leaveCount = new Map<number, number>();
  for (const l of leaves) leaveCount.set(l.userId, (leaveCount.get(l.userId) ?? 0) + 1);
  return { company, users, leaveTypes, typeById: new Map(leaveTypes.map((t) => [t.id, t])), leaves, leaveCount };
}

/**
 * The company's settings as OOOhm takes them: TimeOff's company schedule (Monday to
 * Friday when it has none, or no working day), its time zone when OOOhm knows it, and its
 * carry-over as the pool type's carryover (a very large number means no cap).
 */
export function planCompany(snapshot: TimeOffSnapshot, company: TimeOffCompany, warn: Warn): PlannedCompany {
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
  return {
    timeoffId: company.id,
    name: company.name,
    timezone,
    workingDays,
    carryoverEnabled: carryOver > 0,
    carryoverMaxDays: carryOver > UNLIMITED_CARRY_OVER ? null : carryOver > 0 ? carryOver : null,
  };
}

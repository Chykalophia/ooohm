import { and, asc, between, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { companies, departments, holidays, leaveRequests, leaveTypes, user } from "@/db/schema";
import type { Executor } from "@/db/types";
import { ACTIVE_STATUSES, earliestOverlappingStart } from "@/domain/leave-request";

const settingsFields = {
  timezone: companies.timezone,
  workingDays: companies.workingDays,
  allowancePolicy: companies.allowancePolicy,
};

export async function findCompanySettings(ex: Executor, companyId: string) {
  const [row] = await ex.select(settingsFields).from(companies).where(eq(companies.id, companyId));
  return row;
}

/** Every company with its calendar settings, for jobs that run across all of them. */
export async function listCompanies(ex: Executor) {
  return ex
    .select({ id: companies.id, ...settingsFields })
    .from(companies)
    .orderBy(asc(companies.createdAt), asc(companies.id));
}

/** Company holiday dates (`YYYY-MM-DD`) from `from` to `to`, inclusive. */
export async function listHolidayDates(ex: Executor, companyId: string, from: string, to: string) {
  const rows = await ex
    .select({ date: holidays.date })
    .from(holidays)
    .where(and(eq(holidays.companyId, companyId), between(holidays.date, from, to)));
  return rows.map((r) => r.date);
}

/** Company holidays with their names from `from` to `to`, inclusive, by date. */
export async function listHolidays(ex: Executor, companyId: string, from: string, to: string) {
  return ex
    .select({ date: holidays.date, name: holidays.name })
    .from(holidays)
    .where(and(eq(holidays.companyId, companyId), between(holidays.date, from, to)))
    .orderBy(asc(holidays.date));
}

/**
 * What a calendar may show of a request. No note, decision note or approver: calendars
 * are seen by people other than the requester and their approver.
 */
const entryFields = {
  id: leaveRequests.id,
  userId: leaveRequests.userId,
  startDate: leaveRequests.startDate,
  endDate: leaveRequests.endDate,
  dayPortion: leaveRequests.dayPortion,
  status: leaveRequests.status,
  updatedAt: leaveRequests.updatedAt,
  leaveTypeName: leaveTypes.name,
  leaveTypeCode: leaveTypes.code,
  leaveTypeColor: leaveTypes.color,
};

/**
 * Pending or approved requests of the company whose dates intersect `[from, to]`.
 *
 * `end_date >= from` cannot bound a scan of `(company_id, start_date, end_date)`, so on
 * its own the scan would read the company's whole history before `to`. A request spans
 * at most `MAX_REQUEST_SPAN_DAYS` days (the `leave_requests_span_max` check), so
 * one that reaches `from` starts no earlier than {@link earliestOverlappingStart}: that
 * bound makes the index range two-sided.
 */
function activeInRange(companyId: string, from: string, to: string): SQL | undefined {
  return and(
    eq(leaveRequests.companyId, companyId),
    inArray(leaveRequests.status, [...ACTIVE_STATUSES]),
    gte(leaveRequests.startDate, earliestOverlappingStart(from)),
    lte(leaveRequests.startDate, to),
    gte(leaveRequests.endDate, from),
  );
}

/** One person's pending and approved leave intersecting `[from, to]`. */
export async function listPersonalEntries(ex: Executor, companyId: string, userId: string, from: string, to: string) {
  return ex
    .select(entryFields)
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .where(and(activeInRange(companyId, from, to), eq(leaveRequests.userId, userId)))
    .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.id));
}

/**
 * Pending and approved leave of every active member of the company intersecting
 * `[from, to]`, with each person's name, email (the fallback label when the name is
 * blank) and department. One query whatever the number of people or requests: a
 * range scan on `leave_requests_company_dates_idx`.
 *
 * @param departmentId Only people in this department; already checked to belong to
 *   the company.
 */
export async function listTeamEntries(
  ex: Executor,
  companyId: string,
  from: string,
  to: string,
  departmentId: string | null = null,
) {
  return ex
    .select({
      ...entryFields,
      personName: user.name,
      personEmail: user.email,
      departmentId: user.departmentId,
      departmentName: departments.name,
    })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .innerJoin(user, eq(user.id, leaveRequests.userId))
    .leftJoin(departments, eq(departments.id, user.departmentId))
    .where(
      and(
        activeInRange(companyId, from, to),
        eq(user.companyId, companyId),
        eq(user.isActive, true),
        departmentId ? eq(user.departmentId, departmentId) : undefined,
      ),
    )
    .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.id));
}

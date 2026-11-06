import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { leaveRequestDays, leaveRequests, user } from "@/db/schema";
import type { Executor } from "@/db/types";

/**
 * Everyone a report covers, active or not, deleted people whose records were kept
 * included (their tombstone name): the whole company, or the people reporting to
 * `managerId`. Optionally one department.
 */
export async function listReportPeople(ex: Executor, companyId: string, filter: { managerId: string | null; departmentId: string | null }) {
  return ex
    .select({ id: user.id, name: user.name, email: user.email, departmentId: user.departmentId, isActive: user.isActive })
    .from(user)
    .where(
      and(
        eq(user.companyId, companyId),
        // A full scrub leaves nothing to report on; a delete that kept records keeps its history.
        or(isNull(user.deletedAt), eq(user.deletionMode, "records_kept")),
        filter.managerId ? eq(user.managerId, filter.managerId) : undefined,
        filter.departmentId ? eq(user.departmentId, filter.departmentId) : undefined,
      ),
    )
    .orderBy(asc(sql`lower(${user.name})`), asc(user.id));
}

/**
 * The requests of `userIds` that charge any of `years`, with what they charged each of
 * those years, one row per request and year (`leave_request_days`). No note, decision
 * note or anything else a report does not show.
 */
export async function listReportRequestDays(ex: Executor, companyId: string, userIds: readonly string[], years: readonly number[]) {
  if (userIds.length === 0 || years.length === 0) return [];
  return ex
    .select({
      id: leaveRequests.id,
      userId: leaveRequests.userId,
      leaveTypeId: leaveRequests.leaveTypeId,
      status: leaveRequests.status,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      dayPortion: leaveRequests.dayPortion,
      approverId: leaveRequests.approverId,
      createdAt: leaveRequests.createdAt,
      decidedAt: leaveRequests.decidedAt,
      year: leaveRequestDays.year,
      days: leaveRequestDays.days,
    })
    .from(leaveRequestDays)
    .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.requestId))
    .where(and(eq(leaveRequests.companyId, companyId), inArray(leaveRequests.userId, [...userIds]), inArray(leaveRequestDays.year, [...years])))
    .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.id), asc(leaveRequestDays.year));
}

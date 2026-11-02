import { and, asc, eq, gt, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { departments, leaveRequests, user } from "@/db/schema";
import type { Executor } from "@/db/types";
import type { Role } from "@/domain/actor";
import type { CalendarDate } from "@/domain/calendar-date";
import { earliestOverlappingStart, type LeaveStatus } from "@/domain/leave-request";

/**
 * Read queries of the REST API (`/api/v1`). Each page is one query, keyset-paged on an
 * index, and every query is scoped by the API key's company. Pages fetch `limit + 1`
 * rows so the service can tell whether another page follows without counting.
 */

/** A person as the API shows them: no session, sign-in or approval-preference data. */
export type ApiUserRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  managerId: string | null;
  isActive: boolean;
  createdAt: Date;
  departmentId: string | null;
  departmentName: string | null;
};

/**
 * A page of the company's people by id, after `afterId`. Served by `user_company_id_idx`.
 * Deleted people are not listed: integrations learn of them from `user.deleted`.
 */
export async function listUsersPage(ex: Executor, input: { companyId: string; afterId?: string; limit: number }): Promise<ApiUserRow[]> {
  return ex
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      managerId: user.managerId,
      isActive: user.isActive,
      createdAt: user.createdAt,
      departmentId: user.departmentId,
      departmentName: departments.name,
    })
    .from(user)
    .leftJoin(departments, eq(departments.id, user.departmentId))
    .where(and(eq(user.companyId, input.companyId), isNull(user.deletedAt), input.afterId ? gt(user.id, input.afterId) : undefined))
    .orderBy(asc(user.id))
    .limit(input.limit + 1);
}

/** A leave request as the API shows it: never the requester's note or the decision note. */
export type ApiLeaveRequestRow = {
  id: string;
  userId: string;
  leaveTypeId: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: "full" | "am" | "pm";
  days: number;
  status: LeaveStatus;
  approverId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface LeaveRequestPageQuery {
  companyId: string;
  /** Requests that end on or after this date. */
  from?: CalendarDate;
  /** Requests that start on or before this date. */
  to?: CalendarDate;
  userId?: string;
  status?: LeaveStatus;
  after?: { startDate: CalendarDate; id: string };
  limit: number;
}

/**
 * A page of the company's leave requests overlapping `[from, to]`, by `(start_date, id)`,
 * after the cursor. Served by `leave_requests_company_start_id_idx`; with `from`, the
 * scan also starts no earlier than a request that long could begin
 * (`earliestOverlappingStart`), as the calendar's range queries do.
 */
export async function listLeaveRequestsPage(ex: Executor, q: LeaveRequestPageQuery): Promise<ApiLeaveRequestRow[]> {
  return ex
    .select({
      id: leaveRequests.id,
      userId: leaveRequests.userId,
      leaveTypeId: leaveRequests.leaveTypeId,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      dayPortion: leaveRequests.dayPortion,
      days: leaveRequests.days,
      status: leaveRequests.status,
      approverId: leaveRequests.approverId,
      decidedAt: leaveRequests.decidedAt,
      createdAt: leaveRequests.createdAt,
      updatedAt: leaveRequests.updatedAt,
    })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.companyId, q.companyId),
        q.to ? lte(leaveRequests.startDate, q.to) : undefined,
        q.from ? gte(leaveRequests.endDate, q.from) : undefined,
        q.from ? gte(leaveRequests.startDate, earliestOverlappingStart(q.from)) : undefined,
        q.userId ? eq(leaveRequests.userId, q.userId) : undefined,
        q.status ? eq(leaveRequests.status, q.status) : undefined,
        q.after ? sql`(${leaveRequests.startDate}, ${leaveRequests.id}) > (${q.after.startDate}::date, ${q.after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.id))
    .limit(q.limit + 1);
}

/**
 * The company's people for a balance listing: everyone active, or one person (active or
 * not, or deleted with their records kept). Never a scrubbed person, who has no balance
 * to report.
 */
export async function listBalanceSubjects(ex: Executor, companyId: string, userId?: string) {
  return ex
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.companyId, companyId),
        or(isNull(user.deletedAt), ne(user.deletionMode, "scrubbed")),
        userId ? eq(user.id, userId) : eq(user.isActive, true),
      ),
    )
    .orderBy(asc(user.id));
}

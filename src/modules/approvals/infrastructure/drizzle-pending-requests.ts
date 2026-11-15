import "server-only";
/**
 * The pending requests an admin change may move to another approver, read for
 * `reroutePending` inside the change's transaction. Oldest first.
 */
import { and, asc, eq, getTableColumns, ne } from "drizzle-orm";
import { leaveRequests, user } from "@/db/schema";
import type { Executor } from "@/db/types";
import type { LeaveRequest } from "@/modules/leave";

/** Pending requests of the company assigned to `approverId`, other than their own, oldest first. */
export async function listPendingAssignedTo(ex: Executor, companyId: string, approverId: string): Promise<LeaveRequest[]> {
  return ex
    .select()
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.companyId, companyId),
        eq(leaveRequests.approverId, approverId),
        eq(leaveRequests.status, "pending"),
        ne(leaveRequests.userId, approverId),
      ),
    )
    .orderBy(asc(leaveRequests.createdAt), asc(leaveRequests.id));
}

/**
 * A person's own pending requests, whoever they wait on: someone else, nobody, or
 * themself (an admin's request routed to themself), oldest first.
 */
export async function listPendingRequestsOf(ex: Executor, companyId: string, userId: string): Promise<LeaveRequest[]> {
  return ex
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId), eq(leaveRequests.status, "pending")))
    .orderBy(asc(leaveRequests.createdAt), asc(leaveRequests.id));
}

/** Pending requests from anyone in the department (active or not), oldest first. */
export async function listPendingRequestsInDepartment(ex: Executor, companyId: string, departmentId: string): Promise<LeaveRequest[]> {
  return ex
    .select(getTableColumns(leaveRequests))
    .from(leaveRequests)
    .innerJoin(user, eq(user.id, leaveRequests.userId))
    .where(and(eq(leaveRequests.companyId, companyId), eq(user.departmentId, departmentId), eq(leaveRequests.status, "pending")))
    .orderBy(asc(leaveRequests.createdAt), asc(leaveRequests.id));
}

/**
 * The company's pending requests routed to their own requester, oldest first. The
 * approval rule does that only for an admin with no active manager and no other active
 * admin, so these are the requests to re-route when that stops being true.
 */
export async function listPendingSelfRouted(ex: Executor, companyId: string): Promise<LeaveRequest[]> {
  return ex
    .select()
    .from(leaveRequests)
    .where(
      and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.status, "pending"), eq(leaveRequests.approverId, leaveRequests.userId)),
    )
    .orderBy(asc(leaveRequests.createdAt), asc(leaveRequests.id));
}

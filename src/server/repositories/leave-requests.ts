import { and, asc, count, desc, eq, gt, gte, inArray, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { leaveRequests, leaveTypes, user } from "@/db/schema";
import type { Executor } from "@/db/types";
import type { LeaveStatus } from "@/domain/leave-request";

export type LeaveRequestRow = typeof leaveRequests.$inferSelect;
export type NewLeaveRequest = typeof leaveRequests.$inferInsert;

export async function insertLeaveRequest(ex: Executor, values: NewLeaveRequest): Promise<LeaveRequestRow> {
  const [row] = await ex.insert(leaveRequests).values(values).returning();
  return row;
}

export async function findLeaveRequest(ex: Executor, companyId: string, id: string) {
  const [row] = await ex
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.companyId, companyId)));
  return row;
}

/**
 * How many requests, in any status, the person created in the last `minutes`,
 * measured on the database clock that also stamps `created_at`.
 */
export async function countRecentRequests(ex: Executor, userId: string, minutes: number): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.userId, userId),
        gt(leaveRequests.createdAt, sql`now() - make_interval(mins => ${minutes})`),
      ),
    );
  return row?.n ?? 0;
}

/** The requester's pending/approved requests whose dates intersect `[from, to]`. */
export async function listActiveRequestsInRange(ex: Executor, userId: string, from: string, to: string) {
  return ex
    .select({
      id: leaveRequests.id,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      dayPortion: leaveRequests.dayPortion,
    })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.userId, userId),
        inArray(leaveRequests.status, ["pending", "approved"]),
        lte(leaveRequests.startDate, to),
        gte(leaveRequests.endDate, from),
      ),
    );
}

/**
 * Moves a request from `from` to `to` only if it is still in `from` (compare-and-set).
 * Two concurrent decisions on the same request cannot both succeed: the loser matches
 * no row and gets `undefined`.
 */
export async function updateStatusIfCurrent(
  ex: Executor,
  where: { companyId: string; id: string; from: LeaveStatus },
  set: { status: LeaveStatus; decidedAt?: Date; decisionNote?: string | null },
): Promise<LeaveRequestRow | undefined> {
  const [row] = await ex
    .update(leaveRequests)
    .set(set)
    .where(
      and(
        eq(leaveRequests.id, where.id),
        eq(leaveRequests.companyId, where.companyId),
        eq(leaveRequests.status, where.from),
      ),
    )
    .returning();
  return row;
}

const approver = alias(user, "approver");
const requester = alias(user, "requester");

/** A person's own requests, newest dates first, with display names resolved. */
export async function listRequestsForUser(ex: Executor, companyId: string, userId: string, limit: number) {
  return ex
    .select({
      id: leaveRequests.id,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      dayPortion: leaveRequests.dayPortion,
      days: leaveRequests.days,
      status: leaveRequests.status,
      note: leaveRequests.note,
      decisionNote: leaveRequests.decisionNote,
      leaveTypeName: leaveTypes.name,
      leaveTypeColor: leaveTypes.color,
      approverId: leaveRequests.approverId,
      approverName: approver.name,
    })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .leftJoin(approver, eq(approver.id, leaveRequests.approverId))
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId)))
    .orderBy(desc(leaveRequests.startDate), desc(leaveRequests.createdAt))
    .limit(limit);
}

/** Who is asking for the inbox, and whether they see every pending request in the company. */
export interface InboxScope {
  companyId: string;
  deciderId: string;
  isAdmin: boolean;
}

/**
 * Pending requests the decider may act on: those assigned to them, plus (for admins)
 * every other pending request in the company. A person's own requests appear only to
 * an admin who is its assigned approver, mirroring `canDecide`.
 */
function inboxWhere(scope: InboxScope): SQL | undefined {
  const assigned = eq(leaveRequests.approverId, scope.deciderId);
  const notOwn = ne(leaveRequests.userId, scope.deciderId);
  return and(
    eq(leaveRequests.companyId, scope.companyId),
    eq(leaveRequests.status, "pending"),
    scope.isAdmin ? or(assigned, notOwn) : and(assigned, notOwn),
  );
}

export async function listInbox(ex: Executor, scope: InboxScope, limit: number) {
  return ex
    .select({
      id: leaveRequests.id,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      dayPortion: leaveRequests.dayPortion,
      days: leaveRequests.days,
      note: leaveRequests.note,
      createdAt: leaveRequests.createdAt,
      leaveTypeName: leaveTypes.name,
      leaveTypeColor: leaveTypes.color,
      requesterId: leaveRequests.userId,
      requesterName: requester.name,
      requesterEmail: requester.email,
      approverId: leaveRequests.approverId,
      approverName: approver.name,
    })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .innerJoin(requester, eq(requester.id, leaveRequests.userId))
    .leftJoin(approver, eq(approver.id, leaveRequests.approverId))
    .where(inboxWhere(scope))
    .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.createdAt))
    .limit(limit);
}

export async function countInbox(ex: Executor, scope: InboxScope): Promise<number> {
  const [row] = await ex.select({ n: count() }).from(leaveRequests).where(inboxWhere(scope));
  return row?.n ?? 0;
}

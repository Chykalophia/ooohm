import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { auditLog, departments, leaveRequests, leaveTypes, user } from "@/db/schema";
import type { Executor } from "@/db/types";
import type { LeaveStatus } from "@/domain/leave-request";

export type LeaveRequestRow = typeof leaveRequests.$inferSelect;
export type NewLeaveRequest = typeof leaveRequests.$inferInsert;

export async function insertLeaveRequest(ex: Executor, values: NewLeaveRequest): Promise<LeaveRequestRow> {
  const [row] = await ex.insert(leaveRequests).values(values).returning();
  return row;
}

/** A request of the company; one of another company reads as missing (`undefined`). */
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
    .where(and(eq(leaveRequests.userId, userId), gt(leaveRequests.createdAt, sql`now() - make_interval(mins => ${minutes})`)));
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
 * no row and gets `undefined`. With `approverId`, the request must also still be
 * assigned to that person, so a decision resting on the assignment loses to a
 * concurrent reassignment.
 */
export async function updateStatusIfCurrent(
  ex: Executor,
  where: { companyId: string; id: string; from: LeaveStatus; approverId?: string },
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
        where.approverId === undefined ? undefined : eq(leaveRequests.approverId, where.approverId),
      ),
    )
    .returning();
  return row;
}

/** Pending requests of the company assigned to `approverId`, other than their own, oldest first. */
export async function listPendingAssignedTo(ex: Executor, companyId: string, approverId: string): Promise<LeaveRequestRow[]> {
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
export async function listPendingRequestsOf(ex: Executor, companyId: string, userId: string): Promise<LeaveRequestRow[]> {
  return ex
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId), eq(leaveRequests.status, "pending")))
    .orderBy(asc(leaveRequests.createdAt), asc(leaveRequests.id));
}

/**
 * The company's pending requests routed to their own requester, oldest first. The
 * approval rule does that only for an admin with no active manager and no other active
 * admin, so these are the requests to re-route when that stops being true.
 */
export async function listPendingSelfRouted(ex: Executor, companyId: string): Promise<LeaveRequestRow[]> {
  return ex
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.status, "pending"), eq(leaveRequests.approverId, leaveRequests.userId)))
    .orderBy(asc(leaveRequests.createdAt), asc(leaveRequests.id));
}

/**
 * Moves a pending request from one approver to another, only if it is still pending
 * and still assigned to `from` (`null`: assigned to nobody) (compare-and-set, like
 * {@link updateStatusIfCurrent}).
 */
export async function reassignIfCurrent(
  ex: Executor,
  where: { companyId: string; id: string; from: string | null },
  approverId: string | null,
): Promise<LeaveRequestRow | undefined> {
  const [row] = await ex
    .update(leaveRequests)
    .set({ approverId })
    .where(
      and(
        eq(leaveRequests.id, where.id),
        eq(leaveRequests.companyId, where.companyId),
        eq(leaveRequests.status, "pending"),
        where.from === null ? isNull(leaveRequests.approverId) : eq(leaveRequests.approverId, where.from),
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
  /**
   * Narrows an admin's inbox: `mine` is what is assigned to them or to nobody, `others`
   * what is assigned to someone else. Omitted, the whole inbox. A non-admin's inbox is
   * all `mine`.
   */
  part?: "mine" | "others";
}

/**
 * Pending requests the decider may act on: those assigned to them, plus (for admins)
 * every other pending request in the company. A person's own requests appear only to
 * an admin who is its assigned approver, mirroring `canDecide`. Unlike `canDecide`, it
 * does not re-check that the approval rule still picks the assignee; admin changes
 * re-route as they happen, so only a submit racing one can leave a stale assignment here.
 */
function inboxWhere(scope: InboxScope): SQL | undefined {
  const assigned = eq(leaveRequests.approverId, scope.deciderId);
  const notOwn = ne(leaveRequests.userId, scope.deciderId);
  let who: SQL | undefined;
  if (!scope.isAdmin) who = scope.part === "others" ? sql`false` : and(assigned, notOwn);
  else if (scope.part === "mine") who = or(assigned, and(isNull(leaveRequests.approverId), notOwn));
  else if (scope.part === "others") who = and(ne(leaveRequests.approverId, scope.deciderId), notOwn);
  else who = or(assigned, notOwn);
  return and(eq(leaveRequests.companyId, scope.companyId), eq(leaveRequests.status, "pending"), who);
}

/**
 * Pending requests the inbox shows for `scope`, earliest start first, with requester (and
 * their department), leave type and assigned approver names joined in: at most `limit`
 * rows, one query.
 */
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
      requesterDepartmentId: requester.departmentId,
      requesterDepartmentName: departments.name,
      approverId: leaveRequests.approverId,
      approverName: approver.name,
    })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .innerJoin(requester, eq(requester.id, leaveRequests.userId))
    .leftJoin(departments, eq(departments.id, requester.departmentId))
    .leftJoin(approver, eq(approver.id, leaveRequests.approverId))
    .where(inboxWhere(scope))
    .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.createdAt))
    .limit(limit);
}

/** How many requests {@link listInbox} would show without its limit. */
export async function countInbox(ex: Executor, scope: InboxScope): Promise<number> {
  const [row] = await ex.select({ n: count() }).from(leaveRequests).where(inboxWhere(scope));
  return row?.n ?? 0;
}

/** The two audit actions that record a decision on a request. */
const DECISION_ACTIONS = ["leave_request.approved", "leave_request.rejected"] as const;

/**
 * Requests `deciderId` approved or declined since `since`, newest decision first, with
 * the decision as audited and the request as it is now (it may have been cancelled
 * since). Leaves out the decider's own requests, which self-approval also records as
 * theirs. At most `limit` rows, one query on `audit_log_company_actor_idx`.
 */
export async function listRecentDecisions(ex: Executor, q: { companyId: string; deciderId: string; since: Date }, limit: number) {
  return ex
    .select({
      id: leaveRequests.id,
      action: auditLog.action,
      decidedAt: auditLog.createdAt,
      status: leaveRequests.status,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      dayPortion: leaveRequests.dayPortion,
      days: leaveRequests.days,
      decisionNote: leaveRequests.decisionNote,
      leaveTypeName: leaveTypes.name,
      leaveTypeColor: leaveTypes.color,
      requesterName: requester.name,
      requesterEmail: requester.email,
    })
    .from(auditLog)
    .innerJoin(leaveRequests, eq(sql`${leaveRequests.id}::text`, auditLog.entityId))
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .innerJoin(requester, eq(requester.id, leaveRequests.userId))
    .where(
      and(
        eq(auditLog.companyId, q.companyId),
        eq(auditLog.actorId, q.deciderId),
        gte(auditLog.createdAt, q.since),
        inArray(auditLog.action, [...DECISION_ACTIONS]),
        eq(auditLog.entityType, "leave_request"),
        eq(leaveRequests.companyId, q.companyId),
        ne(leaveRequests.userId, q.deciderId),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}

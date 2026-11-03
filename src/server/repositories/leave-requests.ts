import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
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
  return and(
    eq(leaveRequests.companyId, scope.companyId),
    eq(leaveRequests.status, "pending"),
    scope.isAdmin ? or(assigned, notOwn) : and(assigned, notOwn),
  );
}

/**
 * Pending requests the inbox shows for `scope`, earliest start first, with requester, leave
 * type and assigned approver names joined in: at most `limit` rows, one query.
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

/** How many requests {@link listInbox} would show without its limit. */
export async function countInbox(ex: Executor, scope: InboxScope): Promise<number> {
  const [row] = await ex.select({ n: count() }).from(leaveRequests).where(inboxWhere(scope));
  return row?.n ?? 0;
}

/** One request with what an approver reads before deciding: requester, leave type, dates, days and note. */
export async function findRequestForReview(ex: Executor, companyId: string, id: string) {
  const [row] = await ex
    .select({
      id: leaveRequests.id,
      status: leaveRequests.status,
      approverId: leaveRequests.approverId,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      dayPortion: leaveRequests.dayPortion,
      days: leaveRequests.days,
      note: leaveRequests.note,
      leaveTypeName: leaveTypes.name,
      leaveTypeColor: leaveTypes.color,
      requesterName: requester.name,
      requesterEmail: requester.email,
    })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .innerJoin(requester, eq(requester.id, leaveRequests.userId))
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.id, id)));
  return row;
}

/**
 * Each approver's median time from request to decision, in hours, over the requests
 * assigned to them that were decided since `since` (by them, or by an admin stepping
 * in: either way, it is how long a request routed to them waited): only approvers with at least `minSamples` such decisions,
 * and never a request routed to its own requester (self-approval decides instantly).
 * One grouped query.
 */
export async function medianDecisionHours(ex: Executor, q: { companyId: string; approverIds: readonly string[]; since: Date; minSamples: number }) {
  if (q.approverIds.length === 0) return [];
  return ex
    .select({
      // Never null: the filter below keeps only the listed approvers.
      approverId: sql<string>`${leaveRequests.approverId}`,
      hours:
        sql<number>`percentile_cont(0.5) within group (order by extract(epoch from (${leaveRequests.decidedAt} - ${leaveRequests.createdAt})) / 3600)`.mapWith(
          Number,
        ),
    })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.companyId, q.companyId),
        inArray(leaveRequests.approverId, [...q.approverIds]),
        inArray(leaveRequests.status, ["approved", "rejected"]),
        gte(leaveRequests.decidedAt, q.since),
        ne(leaveRequests.userId, leaveRequests.approverId),
      ),
    )
    .groupBy(leaveRequests.approverId)
    .having(sql`count(*) >= ${q.minSamples}`);
}

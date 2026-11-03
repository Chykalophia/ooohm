import { and, asc, count, eq, gt, gte, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { auditLog, departments, leaveRequests, leaveTypes, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { LeaveStatus } from "@/domain/leave-request";
import type { PageRequest } from "@/domain/paging";
import { activeInRange } from "./calendar";
import { cursorInstant, keysetPage } from "./keyset";

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
 * {@link findLeaveRequest}, holding the row `FOR UPDATE` until commit: for a change whose
 * audit row records the request before it. A recount that holds the row is waited for,
 * so "before" shows its days rather than the ones it replaced (the change's own update
 * would wait on the same lock anyway; this takes it before the read instead of after).
 */
export async function lockLeaveRequest(tx: Transaction, companyId: string, id: string) {
  const [row] = await tx
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.companyId, companyId)))
    .for("update");
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
    .where(
      and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.status, "pending"), eq(leaveRequests.approverId, leaveRequests.userId)),
    )
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

/**
 * Whether the person has time off approved in this company right now, however far back
 * its dates are. A request that was approved and later cancelled doesn't count: it put
 * nothing in a calendar.
 */
export async function hasApprovedRequest(ex: Executor, companyId: string, userId: string): Promise<boolean> {
  const [row] = await ex
    .select({ id: leaveRequests.id })
    .from(leaveRequests)
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId), eq(leaveRequests.status, "approved")))
    .limit(1);
  return row !== undefined;
}

/** The key part values of a `[start_date, created_at, id]` page key. */
const dateInstantId = ([date, at, id]: string[]) => [sql`${date}::date`, sql`${at}::timestamptz`, sql`${id}::uuid`];

/** What a person sees of their own request, with the leave type and approver named. */
const ownRequestFields = {
  id: leaveRequests.id,
  cursor: cursorInstant(leaveRequests.createdAt),
  startDate: leaveRequests.startDate,
  endDate: leaveRequests.endDate,
  dayPortion: leaveRequests.dayPortion,
  days: leaveRequests.days,
  status: leaveRequests.status,
  note: leaveRequests.note,
  decisionNote: leaveRequests.decisionNote,
  createdAt: leaveRequests.createdAt,
  decidedAt: leaveRequests.decidedAt,
  leaveTypeName: leaveTypes.name,
  leaveTypeColor: leaveTypes.color,
  approverId: leaveRequests.approverId,
  approverName: approver.name,
};

/**
 * A page of a person's own requests, latest dates first (then latest sent), with
 * display names resolved. Keyed on `[start_date, created_at, id]`; `cursor` is
 * `created_at` as {@link cursorInstant} prints it.
 */
export async function listRequestsForUser(ex: Executor, companyId: string, userId: string, limit: number, page?: PageRequest) {
  const keyset = keysetPage("desc", [leaveRequests.startDate, leaveRequests.createdAt, leaveRequests.id], page, dateInstantId);
  return ex
    .select(ownRequestFields)
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .leftJoin(approver, eq(approver.id, leaveRequests.approverId))
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId), keyset.where))
    .orderBy(...keyset.orderBy)
    .limit(limit);
}

/** One of a person's own requests, as {@link listRequestsForUser} reads them, or `undefined` (someone else's included). */
export async function findRequestOfUser(ex: Executor, companyId: string, userId: string, id: string) {
  const [row] = await ex
    .select(ownRequestFields)
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .leftJoin(approver, eq(approver.id, leaveRequests.approverId))
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId)));
  return row;
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
 * A page of the pending requests the inbox shows for `scope`, earliest start first (then
 * first sent), with requester (and their department), leave type and assigned approver
 * names joined in: at most `limit` rows, one query. Keyed on `[start_date, created_at,
 * id]` like {@link listRequestsForUser}.
 */
export async function listInbox(ex: Executor, scope: InboxScope, limit: number, page?: PageRequest) {
  const keyset = keysetPage("asc", [leaveRequests.startDate, leaveRequests.createdAt, leaveRequests.id], page, dateInstantId);
  return ex
    .select({
      id: leaveRequests.id,
      cursor: cursorInstant(leaveRequests.createdAt),
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
    .where(and(inboxWhere(scope), keyset.where))
    .orderBy(...keyset.orderBy)
    .limit(limit);
}

/** How many requests {@link listInbox} would show without its limit. */
export async function countInbox(ex: Executor, scope: InboxScope): Promise<number> {
  const [row] = await ex.select({ n: count() }).from(leaveRequests).where(inboxWhere(scope));
  return row?.n ?? 0;
}

/**
 * Locks and returns the company's pending and approved requests that include any of
 * `dates`, or (with `{ from }`) every one ending on or after `from`; oldest start first.
 * Locked `FOR UPDATE`, so a decision, cancel or reassignment of one of them waits until
 * the caller's transaction ends. Requests on none of the dates are neither read nor
 * locked, even between two of them.
 */
export async function lockActiveRequestsOnDates(
  tx: Transaction,
  companyId: string,
  dates: readonly string[] | { from: string },
): Promise<LeaveRequestRow[]> {
  let where: SQL | undefined;
  if ("from" in dates) {
    where = and(
      eq(leaveRequests.companyId, companyId),
      inArray(leaveRequests.status, ["pending", "approved"]),
      gte(leaveRequests.endDate, dates.from),
    );
  } else {
    if (dates.length === 0) return [];
    const sorted = [...dates].sort();
    where = and(
      activeInRange(companyId, sorted[0], sorted[sorted.length - 1]),
      or(...sorted.map((d) => and(lte(leaveRequests.startDate, d), gte(leaveRequests.endDate, d)))),
    );
  }
  return tx.select().from(leaveRequests).where(where).orderBy(asc(leaveRequests.startDate), asc(leaveRequests.id)).for("update");
}

/** Sets a request's total `days`; its per-year split is replaced separately ({@link replaceRequestDays}). */
export async function updateRequestDays(tx: Transaction, companyId: string, id: string, days: number): Promise<LeaveRequestRow> {
  const [row] = await tx
    .update(leaveRequests)
    .set({ days })
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.companyId, companyId)))
    .returning();
  // The caller locked the row earlier in this transaction, so it is there; fail loudly if not.
  if (!row) throw new Error(`leave request ${id} missing while its days were updated`);
  return row;
}

/** The two audit actions that record a decision on a request. */
const DECISION_ACTIONS = ["leave_request.approved", "leave_request.rejected"] as const;

/**
 * Requests `deciderId` approved or declined since `since`, newest decision first, with
 * the decision as audited and the request as it is now (it may have been cancelled
 * since). Leaves out the decider's own requests, which self-approval also records as
 * theirs. A page of `limit` rows, keyed on the audit row's `[created_at, id]` (`cursor`
 * is `created_at` as {@link cursorInstant} prints it), one query on
 * `audit_log_company_actor_idx`.
 */
export async function listRecentDecisions(
  ex: Executor,
  q: { companyId: string; deciderId: string; since: Date },
  limit: number,
  page?: PageRequest,
) {
  const keyset = keysetPage("desc", [auditLog.createdAt, auditLog.id], page, ([at, id]) => [sql`${at}::timestamptz`, sql`${id}::uuid`]);
  return ex
    .select({
      auditId: auditLog.id,
      cursor: cursorInstant(auditLog.createdAt),
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
        keyset.where,
      ),
    )
    .orderBy(...keyset.orderBy)
    .limit(limit);
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

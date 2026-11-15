import "server-only";
import { and, asc, count, eq, gt, gte, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { leaveRequests, leaveTypes, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";
import type { PageRequest } from "@/domain/paging";
import { activeInRange } from "@/shared/lib/db/active-leave";
import { cursorInstant, keysetPage } from "@/shared/lib/db/keyset";
import { listActiveRequestsInRange } from "@/shared/lib/db/leave-requests";
import { earliestOverlappingStart, type LeaveStatus } from "@/shared/kernel/leave-range";
import type { ApiLeaveRequest, ApiLeaveRequestPage, LeaveRequestRepository } from "../application/ports";
import type { LeaveRequest } from "../domain/leave-request";
import { insertRequestDays, listRequestDays, replaceRequestDays } from "./drizzle-leave-request-days";

/** A `leave_requests` row. Stays inside this file: callers get a {@link LeaveRequest}. */
type LeaveRequestRow = typeof leaveRequests.$inferSelect;

/** A row as the aggregate. */
export function toLeaveRequest(row: LeaveRequestRow): LeaveRequest {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    leaveTypeId: row.leaveTypeId,
    startDate: row.startDate,
    endDate: row.endDate,
    dayPortion: row.dayPortion,
    days: row.days,
    note: row.note,
    status: row.status,
    approverId: row.approverId,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const toOptional = (row: LeaveRequestRow | undefined) => (row ? toLeaveRequest(row) : undefined);

/**
 * The leave request repository on Drizzle, bound to `ex`: the pool for reads, or a
 * transaction for a unit of work. Locking methods need a transaction.
 */
export function drizzleLeaveRequestRepository(ex: Executor): LeaveRequestRepository {
  const tx = ex as Transaction;
  return {
    find: (companyId, id) => findLeaveRequest(ex, companyId, id).then(toOptional),
    lock: (companyId, id) => lockLeaveRequest(tx, companyId, id).then(toOptional),
    countRecentByRequester: (userId, minutes) => countRecentRequests(ex, userId, minutes),
    findActiveOverlapping: (userId, range) => listActiveRequestsInRange(ex, userId, range.startDate, range.endDate),
    insert: (request) => insertLeaveRequest(ex, request),
    saveYearDays: (requestId, split) => insertRequestDays(tx, requestId, split),
    updateStatusIfCurrent: (where, set) => updateStatusIfCurrent(ex, where, set).then(toOptional),
    reassignIfCurrent: (where, approverId) => reassignIfCurrent(ex, where, approverId).then(toOptional),
    lockActiveOnDates: (companyId, dates) => lockActiveRequestsOnDates(tx, companyId, dates).then((rows) => rows.map(toLeaveRequest)),
    listYearDays: (requestIds) => listRequestDays(ex, requestIds),
    replaceYearDays: (requestId, split) => replaceRequestDays(tx, requestId, split),
    updateDays: (companyId, id, days) => updateRequestDays(tx, companyId, id, days).then(toLeaveRequest),
    listOwn: (companyId, userId, limit, page) => listRequestsForUser(ex, companyId, userId, limit, page),
    findOwn: (companyId, userId, id) => findRequestOfUser(ex, companyId, userId, id),
    medianDecisionHours: (q) => medianDecisionHours(ex, q),
    pageForApi: (q) => listLeaveRequestsPage(ex, q),
  };
}

/**
 * A request of the company (one of another company reads as missing), holding the row `FOR UPDATE` until commit: for a change whose
 * audit row records the request before it. A recount that holds the row is waited for,
 * so "before" shows its days rather than the ones it replaced (the change's own update
 * would wait on the same lock anyway; this takes it before the read instead of after).
 */
async function lockLeaveRequest(tx: Transaction, companyId: string, id: string) {
  const [row] = await tx
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.companyId, companyId)))
    .for("update");
  return row;
}

/**
 * Moves a request from `from` to `to` only if it is still in `from` (compare-and-set).
 * Two concurrent decisions on the same request cannot both succeed: the loser matches
 * no row and gets `undefined`. With `approverId`, the request must also still be
 * assigned to that person, so a decision resting on the assignment loses to a
 * concurrent reassignment.
 */
async function updateStatusIfCurrent(
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

/**
 * Moves a pending request from one approver to another, only if it is still pending
 * and still assigned to `from` (`null`: assigned to nobody) (compare-and-set, like
 * {@link updateStatusIfCurrent}).
 */
async function reassignIfCurrent(
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

/** Stores a new request with the id it was given; its timestamps come from the database clock. */
async function insertLeaveRequest(ex: Executor, request: LeaveRequest): Promise<LeaveRequest> {
  const [row] = await ex
    .insert(leaveRequests)
    .values({ ...request, createdAt: undefined, updatedAt: undefined, decidedAt: undefined })
    .returning();
  return toLeaveRequest(row);
}

/** A request of the company; one of another company reads as missing (`undefined`). */
async function findLeaveRequest(ex: Executor, companyId: string, id: string) {
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
async function countRecentRequests(ex: Executor, userId: string, minutes: number): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(leaveRequests)
    .where(and(eq(leaveRequests.userId, userId), gt(leaveRequests.createdAt, sql`now() - make_interval(mins => ${minutes})`)));
  return row?.n ?? 0;
}

const approver = alias(user, "approver");

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
async function listRequestsForUser(ex: Executor, companyId: string, userId: string, limit: number, page?: PageRequest) {
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
async function findRequestOfUser(ex: Executor, companyId: string, userId: string, id: string) {
  const [row] = await ex
    .select(ownRequestFields)
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .leftJoin(approver, eq(approver.id, leaveRequests.approverId))
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId)));
  return row;
}

/**
 * Locks and returns the company's pending and approved requests that include any of
 * `dates`, or (with `{ from }`) every one ending on or after `from`; oldest start first.
 * Locked `FOR UPDATE`, so a decision, cancel or reassignment of one of them waits until
 * the caller's transaction ends. Requests on none of the dates are neither read nor
 * locked, even between two of them.
 */
async function lockActiveRequestsOnDates(tx: Transaction, companyId: string, dates: readonly string[] | { from: string }): Promise<LeaveRequestRow[]> {
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

/** Sets a request's total `days`; its per-year split is replaced separately (`replaceRequestDays`). */
async function updateRequestDays(tx: Transaction, companyId: string, id: string, days: number): Promise<LeaveRequestRow> {
  const [row] = await tx
    .update(leaveRequests)
    .set({ days })
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.companyId, companyId)))
    .returning();
  // The caller locked the row earlier in this transaction, so it is there; fail loudly if not.
  if (!row) throw new Error(`leave request ${id} missing while its days were updated`);
  return row;
}

/**
 * Each approver's median time from request to decision, in hours, over the requests
 * assigned to them that were decided since `since` (by them, or by an admin stepping
 * in: either way, it is how long a request routed to them waited): only approvers with at least `minSamples` such decisions,
 * and never a request routed to its own requester (self-approval decides instantly).
 * One grouped query.
 */
async function medianDecisionHours(ex: Executor, q: { companyId: string; approverIds: readonly string[]; since: Date; minSamples: number }) {
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

/**
 * A page of the company's leave requests overlapping `[from, to]`, by `(start_date, id)`,
 * after the cursor. Served by `leave_requests_company_start_id_idx`; with `from`, the
 * scan also starts no earlier than a request that long could begin
 * (`earliestOverlappingStart`), as the calendar's range queries do.
 */
async function listLeaveRequestsPage(ex: Executor, q: ApiLeaveRequestPage): Promise<ApiLeaveRequest[]> {
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

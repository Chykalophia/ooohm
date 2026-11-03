import { and, asc, count, eq, gt, gte, inArray, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { leaveRequests, leaveTypes, user } from "@/db/schema";
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
      and(
        eq(leaveRequests.companyId, companyId),
        eq(leaveRequests.status, "pending"),
        eq(leaveRequests.approverId, leaveRequests.userId),
      ),
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

/** The key part values of a `[start_date, created_at, id]` page key. */
const dateInstantId = ([date, at, id]: string[]) => [sql`${date}::date`, sql`${at}::timestamptz`, sql`${id}::uuid`];

/**
 * A page of a person's own requests, latest dates first (then latest sent), with
 * display names resolved. Keyed on `[start_date, created_at, id]`; `cursor` is
 * `created_at` as {@link cursorInstant} prints it.
 */
export async function listRequestsForUser(ex: Executor, companyId: string, userId: string, limit: number, page?: PageRequest) {
  const keyset = keysetPage("desc", [leaveRequests.startDate, leaveRequests.createdAt, leaveRequests.id], page, dateInstantId);
  return ex
    .select({
      id: leaveRequests.id,
      cursor: cursorInstant(leaveRequests.createdAt),
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
    .where(and(eq(leaveRequests.companyId, companyId), eq(leaveRequests.userId, userId), keyset.where))
    .orderBy(...keyset.orderBy)
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
 * A page of the pending requests the inbox shows for `scope`, earliest start first (then
 * first sent), with requester, leave type and assigned approver names joined in: at most
 * `limit` rows, one query. Keyed on `[start_date, created_at, id]` like
 * {@link listRequestsForUser}.
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
      approverId: leaveRequests.approverId,
      approverName: approver.name,
    })
    .from(leaveRequests)
    .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
    .innerJoin(requester, eq(requester.id, leaveRequests.userId))
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
    where = and(eq(leaveRequests.companyId, companyId), inArray(leaveRequests.status, ["pending", "approved"]), gte(leaveRequests.endDate, dates.from));
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
  return row;
}

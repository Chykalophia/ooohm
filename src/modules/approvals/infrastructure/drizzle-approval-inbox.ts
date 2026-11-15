import "server-only";
/** The Approvals page's reads and the review an approve link shows: one query each, on Drizzle. */
import { and, count, eq, gte, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { auditLog, departments, leaveRequests, leaveTypes, user } from "@/db/schema";
import type { Executor } from "@/db/types";
import type { PageRequest } from "@/shared/kernel/paging";
import { alsoOffFor } from "@/modules/leave";
import { cursorInstant, keysetPage } from "@/shared/lib/db/keyset";
import type { ApprovalInbox, InboxRequest, InboxScope, RecentDecision, ReviewRequest } from "../application/ports";

const approver = alias(user, "approver");
const requester = alias(user, "requester");

/** The key part values of a `[start_date, created_at, id]` page key. */
const dateInstantId = ([date, at, id]: string[]) => [sql`${date}::date`, sql`${at}::timestamptz`, sql`${id}::uuid`];

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
 * id]` like a person's own requests.
 */
export async function listInbox(ex: Executor, scope: InboxScope, limit: number, page?: PageRequest): Promise<InboxRequest[]> {
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
): Promise<RecentDecision[]> {
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
export async function findRequestForReview(ex: Executor, companyId: string, id: string): Promise<ReviewRequest | undefined> {
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

/** The {@link ApprovalInbox} on Drizzle, bound to `ex`. */
export function drizzleApprovalInbox(ex: Executor): ApprovalInbox {
  return {
    list: (scope, limit, page) => listInbox(ex, scope, limit, page),
    count: (scope) => countInbox(ex, scope),
    recentDecisions: (q, limit, page) => listRecentDecisions(ex, q, limit, page),
    alsoOff: (companyId, requests, readerId) => alsoOffFor(ex, companyId, requests, readerId),
  };
}

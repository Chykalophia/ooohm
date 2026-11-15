import "server-only";
/**
 * Leave's composition root: binds the use cases to their concrete ports. Everything
 * outside the module calls the functions here (through `index.ts`) with a
 * `ServiceContext`; the use cases themselves take {@link LeaveDeps}, so tests run them on
 * in-memory fakes.
 */
import type { Executor, Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { type ApiClient } from "@/modules/integrations";
import type { ApprovalRule } from "@/domain/approval-rule";
import type { PageCursor } from "@/domain/paging";
import type { ServiceContext } from "@/server/context";
import { approveLinkFor } from "@/server/services/approve-link";
import { commitThenNotify } from "@/modules/notifications";
import type { LeaveDraft } from "@/modules/balances";
import { activeContactsIn, type LeaveChange, recordLeaveChangeIn, recordReassignmentIn } from "./application/leave-changes";
import type { LeaveDeps, LeaveStore } from "./application/ports";
import { alsoOffFor } from "./application/queries/also-off";
import { getDashboard as dashboard } from "./application/queries/get-dashboard";
import { getMyRequest as myRequest } from "./application/queries/get-my-request";
import { listLeaveRequestsForApi as apiLeaveRequests, type LeaveRequestQuery } from "./application/queries/list-leave-requests-for-api";
import { listMyRequests as myRequests } from "./application/queries/list-my-requests";
import { previewLeaveFor as previewFor } from "./application/queries/preview-leave-for";
import { addLeaveFor as addFor } from "./application/use-cases/add-leave-for";
import { cancelLeaveRequest as cancel } from "./application/use-cases/cancel-leave-request";
import { type CalendarChange, recountLeave as recount } from "./application/use-cases/recount-leave";
import { removeLeaveFor as removeFor } from "./application/use-cases/remove-leave-for";
import { type SubmitLeaveInput, submitLeaveRequest as submit } from "./application/use-cases/submit-leave-request";
import type { LeaveRequest } from "./domain/leave-request";
import { approvalsRouter } from "./infrastructure/approvals-router";
import { balancesAllowanceReader } from "./infrastructure/balances-allowance-reader";
import { drizzleChangeLog } from "./infrastructure/drizzle-change-log";
import { drizzleLeaveDirectory } from "./infrastructure/drizzle-leave-directory";
import { drizzleLeaveRequestRepository } from "./infrastructure/drizzle-leave-request.repository";

/** Every port on Drizzle, bound to `ex` (the pool, or one transaction). */
export function leaveStore(ex: Executor): LeaveStore {
  return {
    requests: drizzleLeaveRequestRepository(ex),
    directory: drizzleLeaveDirectory(ex),
    allowances: balancesAllowanceReader(ex),
    approvals: approvalsRouter(ex),
    changes: drizzleChangeLog(ex as Transaction),
    alsoOff: { lines: (companyId, requests, readerId) => alsoOffFor(ex, companyId, requests, readerId) },
  };
}

/** The use cases' dependencies for one service call. */
export function leaveDeps(ctx: ServiceContext): LeaveDeps {
  return {
    clock: { now: () => ctx.now() },
    ids: ctx.ids,
    appUrl: ctx.appUrl,
    approveLink: (requestId, approverId) => approveLinkFor(ctx, requestId, approverId),
    read: leaveStore(ctx.db),
    unitOfWork: (companyId, work) => commitThenNotify(ctx, companyId, (tx) => work(leaveStore(tx))),
  };
}

/** The leave module's use cases and queries, bound to `ctx`. */
export function leaveModule(ctx: ServiceContext) {
  const deps = leaveDeps(ctx);
  return {
    submitLeaveRequest: (actor: Actor, input: SubmitLeaveInput, rule?: ApprovalRule) => submit(deps, actor, input, rule),
    cancelLeaveRequest: (actor: Actor, requestId: string) => cancel(deps, actor, requestId),
    addLeaveFor: (actor: Actor, userId: string, input: SubmitLeaveInput) => addFor(deps, actor, userId, input),
    removeLeaveFor: (actor: Actor, requestId: string, reason: string) => removeFor(deps, actor, requestId, reason),
    previewLeaveFor: (actor: Actor, userId: string, draft: LeaveDraft) => previewFor(deps, actor, userId, draft),
    getDashboard: (actor: Actor) => dashboard(deps, actor),
    listMyRequests: (actor: Actor, page?: PageCursor) => myRequests(deps, actor, page),
    getMyRequest: (actor: Actor, id: string) => myRequest(deps, actor, id),
    listLeaveRequestsForApi: (client: ApiClient, q: LeaveRequestQuery) => apiLeaveRequests(deps, client, q),
  };
}

export const submitLeaveRequest = (ctx: ServiceContext, actor: Actor, input: SubmitLeaveInput, rule?: ApprovalRule) =>
  leaveModule(ctx).submitLeaveRequest(actor, input, rule);
export const cancelLeaveRequest = (ctx: ServiceContext, actor: Actor, requestId: string) => leaveModule(ctx).cancelLeaveRequest(actor, requestId);
export const addLeaveFor = (ctx: ServiceContext, actor: Actor, userId: string, input: SubmitLeaveInput) => leaveModule(ctx).addLeaveFor(actor, userId, input);
export const removeLeaveFor = (ctx: ServiceContext, actor: Actor, requestId: string, reason: string) =>
  leaveModule(ctx).removeLeaveFor(actor, requestId, reason);
export const previewLeaveFor = (ctx: ServiceContext, actor: Actor, userId: string, draft: LeaveDraft) => leaveModule(ctx).previewLeaveFor(actor, userId, draft);
export const getDashboard = (ctx: ServiceContext, actor: Actor) => leaveModule(ctx).getDashboard(actor);
export const listMyRequests = (ctx: ServiceContext, actor: Actor, page?: PageCursor) => leaveModule(ctx).listMyRequests(actor, page);
export const getMyRequest = (ctx: ServiceContext, actor: Actor, id: string) => leaveModule(ctx).getMyRequest(actor, id);
export const listLeaveRequestsForApi = (ctx: ServiceContext, client: ApiClient, q: LeaveRequestQuery) => leaveModule(ctx).listLeaveRequestsForApi(client, q);

/**
 * Recounts requests after a calendar change, inside the caller's transaction `tx` (which
 * holds `lockCompany`). The caller unwraps the result, so a failure rolls `tx` back.
 */
export function recountLeave(tx: Transaction, ctx: ServiceContext, actor: Actor, change: CalendarChange) {
  return recount(leaveDeps(ctx), leaveStore(tx), actor, change);
}

/** Writes the audit row and outbox event for one leave transition another module makes (a decision), inside `tx`. */
export function recordLeaveChange(tx: Transaction, change: LeaveChange): Promise<void> {
  return recordLeaveChangeIn(drizzleChangeLog(tx), change);
}

/** Writes `leave_request.reassigned` and `leave.reassigned` for a pending request moved to another approver, inside `tx`. */
export function recordReassignment(tx: Transaction, change: { before: LeaveRequest; after: LeaveRequest; source: LeaveChange["source"] }): Promise<void> {
  return recordReassignmentIn(drizzleChangeLog(tx), change);
}

/** Active recipients by id, read in `ex`, so a deactivated person is never emailed. */
export function activeContacts(ex: Executor, companyId: string, ids: readonly (string | null)[]) {
  return activeContactsIn(drizzleLeaveDirectory(ex), companyId, ids);
}

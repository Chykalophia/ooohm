import "server-only";
/**
 * Leave's composition root: binds the use cases to their concrete ports. Everything
 * outside the module calls the functions here (through `index.ts`) with a
 * `ServiceContext`; the use cases themselves take {@link LeaveDeps}, so tests run them on
 * in-memory fakes.
 */
import type { Executor, Transaction } from "@/db/types";
import type { Actor } from "@/shared/kernel/actor";
import type { ApiClient } from "@/modules/integrations";
import type { PageCursor } from "@/shared/kernel/paging";
import type { ServiceContext } from "@/server/context";
import type { CompanySettingsInput } from "@/shared/kernel/company-settings";
import { commitThenNotify } from "@/modules/notifications";
import { forTenant } from "@/shared/lib/tenant";
import { saveCompanySettings } from "@/modules/organisation";
import type { LeaveDraft } from "@/modules/balances";
import { activeContactsIn, type LeaveChange, recordLeaveChangeIn, recordReassignmentIn } from "./application/leave-changes";
import type { ApprovalRouter, LeaveDeps, LeaveRequestRepository, LeaveStore } from "./application/ports";
import { alsoOffFor } from "./application/queries/also-off";
import { getDashboard as dashboard } from "./application/queries/get-dashboard";
import { getMyRequest as myRequest } from "./application/queries/get-my-request";
import { listLeaveRequestsForApi as apiLeaveRequests, type LeaveRequestQuery } from "./application/queries/list-leave-requests-for-api";
import { listMyRequests as myRequests } from "./application/queries/list-my-requests";
import { previewLeaveFor as previewFor } from "./application/queries/preview-leave-for";
import { addLeaveFor as addFor } from "./application/use-cases/add-leave-for";
import { cancelLeaveRequest as cancel } from "./application/use-cases/cancel-leave-request";
import { type CalendarChange, recountLeave as recount } from "./application/use-cases/recount-leave";
import { updateCompanySettings as updateSettings } from "./application/use-cases/update-company-settings";
import { removeLeaveFor as removeFor } from "./application/use-cases/remove-leave-for";
import { type SubmitLeaveInput, submitLeaveRequest as submit } from "./application/use-cases/submit-leave-request";
import type { LeaveRequest } from "./domain/leave-request";
import { balancesAllowanceReader } from "./infrastructure/balances-allowance-reader";
import { drizzleChangeLog } from "./infrastructure/drizzle-change-log";
import { drizzleLeaveDirectory } from "./infrastructure/drizzle-leave-directory";
import { drizzleLeaveRequestRepository } from "./infrastructure/drizzle-leave-request.repository";

/**
 * How leave reaches approval routing. The approvals module implements it and the
 * composition root hands it over with {@link provideApprovalRouting} (`wireModules` in
 * `src/server/wiring.ts`), so approvals depends on leave and never the other way.
 */
export interface ApprovalRouting {
  /** The {@link ApprovalRouter} port, bound to `ex`. */
  router(ex: Executor): ApprovalRouter;
  /** The signed Approve link for a request email, or `null` where links cannot be signed. */
  approveLink(ctx: ServiceContext, requestId: string, approverId: string): string | null;
}

/** Kept on `globalThis`, like the background wake, so every module graph in the process sees it. */
const slot = globalThis as unknown as { ooohmApprovalRouting?: ApprovalRouting };

/** Hands leave its approval routing. Called once per process by the composition root; calling again replaces it. */
export function provideApprovalRouting(routing: ApprovalRouting): void {
  slot.ooohmApprovalRouting = routing;
}

function approvalRouting(): ApprovalRouting {
  const routing = slot.ooohmApprovalRouting;
  if (!routing) throw new Error("Approval routing is not wired: call wireModules() from src/server/wiring.ts first.");
  return routing;
}

/** {@link ApprovalRouter} on `ex`, resolved when first used, so reads that never route need no wiring. */
function routerOn(ex: Executor): ApprovalRouter {
  return {
    route: (companyId, requester, mode) => approvalRouting().router(ex).route(companyId, requester, mode),
    currentApprover: (companyId, requesterId) => approvalRouting().router(ex).currentApprover(companyId, requesterId),
  };
}

/** Every port on Drizzle, bound to `ex` (the pool, or one transaction). */
export function leaveStore(ex: Executor): LeaveStore {
  return {
    requests: drizzleLeaveRequestRepository(ex),
    directory: drizzleLeaveDirectory(ex),
    allowances: balancesAllowanceReader(ex),
    approvals: routerOn(ex),
    changes: drizzleChangeLog(ex as Transaction),
    alsoOff: { lines: (companyId, requests, readerId) => alsoOffFor(ex, companyId, requests, readerId) },
  };
}

/** The use cases' dependencies for one service call; reads run for the company `ctx` is scoped to, if any. */
export function leaveDeps(ctx: ServiceContext): LeaveDeps {
  return {
    clock: { now: () => ctx.now() },
    ids: ctx.ids,
    appUrl: ctx.appUrl,
    approveLink: (requestId, approverId) => approvalRouting().approveLink(ctx, requestId, approverId),
    read: leaveStore(ctx.db),
    unitOfWork: (companyId, work) => commitThenNotify(ctx, companyId, (tx) => work(leaveStore(tx))),
  };
}

/** The leave module's use cases and queries, bound to `ctx`; each runs for its actor's (or API key's) company. */
export function leaveModule(ctx: ServiceContext) {
  const deps = (companyId: string) => leaveDeps(forTenant(ctx, companyId));
  return {
    submitLeaveRequest: (actor: Actor, input: SubmitLeaveInput) => submit(deps(actor.companyId), actor, input),
    cancelLeaveRequest: (actor: Actor, requestId: string) => cancel(deps(actor.companyId), actor, requestId),
    addLeaveFor: (actor: Actor, userId: string, input: SubmitLeaveInput) => addFor(deps(actor.companyId), actor, userId, input),
    removeLeaveFor: (actor: Actor, requestId: string, reason: string) => removeFor(deps(actor.companyId), actor, requestId, reason),
    previewLeaveFor: (actor: Actor, userId: string, draft: LeaveDraft) => previewFor(deps(actor.companyId), actor, userId, draft),
    getDashboard: (actor: Actor) => dashboard(deps(actor.companyId), actor),
    listMyRequests: (actor: Actor, page?: PageCursor) => myRequests(deps(actor.companyId), actor, page),
    getMyRequest: (actor: Actor, id: string) => myRequest(deps(actor.companyId), actor, id),
    listLeaveRequestsForApi: (client: ApiClient, q: LeaveRequestQuery) => apiLeaveRequests(deps(client.companyId), client, q),
  };
}

export const submitLeaveRequest = (ctx: ServiceContext, actor: Actor, input: SubmitLeaveInput) => leaveModule(ctx).submitLeaveRequest(actor, input);
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
  return recount(leaveDeps(forTenant(ctx, actor.companyId)), leaveStore(tx), actor, change);
}

/**
 * Saves the company's settings and recounts leave when the working days changed, in one
 * transaction: organisation's `saveCompanySettings` step, then {@link recountLeave}.
 */
export function updateCompanySettings(ctx: ServiceContext, actor: Actor, input: CompanySettingsInput) {
  ctx = forTenant(ctx, actor.companyId);
  const leave = leaveDeps(ctx);
  return updateSettings(
    {
      leave,
      unitOfWork: (companyId, work) =>
        commitThenNotify(ctx, companyId, (tx) => work({ save: (a, i) => saveCompanySettings(tx, a, i) }, leaveStore(tx))),
    },
    actor,
    input,
  );
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

/**
 * A request of the company, holding its row until `tx` ends: for another module's change
 * to it (a decision), whose audit row records the request before it.
 */
export function lockLeaveRequest(tx: Transaction, companyId: string, id: string): Promise<LeaveRequest | undefined> {
  return drizzleLeaveRequestRepository(tx).lock(companyId, id);
}

/**
 * Moves a request from `where.from` to `set.status` only while it is still in `from`
 * (and, with `where.approverId`, still assigned to that person): `undefined` when it
 * lost to a concurrent change. Leave owns the table; approvals decides through this.
 */
export function updateStatusIfCurrent(
  ex: Executor,
  where: Parameters<LeaveRequestRepository["updateStatusIfCurrent"]>[0],
  set: Parameters<LeaveRequestRepository["updateStatusIfCurrent"]>[1],
): Promise<LeaveRequest | undefined> {
  return drizzleLeaveRequestRepository(ex).updateStatusIfCurrent(where, set);
}

/** Moves a pending request to `approverId` only while it is still assigned to `where.from`; `undefined` otherwise. */
export function reassignIfCurrent(ex: Executor, where: { companyId: string; id: string; from: string | null }, approverId: string | null): Promise<LeaveRequest | undefined> {
  return drizzleLeaveRequestRepository(ex).reassignIfCurrent(where, approverId);
}

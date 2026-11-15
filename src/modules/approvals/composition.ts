import "server-only";
/**
 * Approvals' composition root: binds the use cases to their concrete ports. Everything
 * outside the module calls the functions here (through `index.ts`) with a
 * `ServiceContext`; the use cases themselves take {@link ApprovalDeps}, so tests run them
 * on in-memory fakes.
 */
import type { Executor, Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import type { PageCursor } from "@/domain/paging";
import type { ApprovalRouting, LeaveRequest } from "@/modules/leave";
import { commitThenNotify } from "@/modules/notifications";
import type { ServiceContext } from "@/server/context";
import { approveLinkFor as signApproveLink } from "./application/approve-link";
import type { ApprovalsView } from "./application/dto";
import type { ApprovalDeps, ApprovalStore, RoutingRequester } from "./application/ports";
import { getApprovalNav as nav } from "./application/queries/get-approval-nav";
import { getApprovalTriage as triage } from "./application/queries/get-approval-triage";
import { readEmailApproval as readLink } from "./application/queries/read-email-approval";
import { type Rerouted, reroutePending } from "./application/reroute-pending";
import { currentApprover, routeRequest } from "./application/routing";
import { approveFromEmail as approveLink } from "./application/use-cases/approve-from-email";
import { type DecideInput, decideLeaveRequest as decide } from "./application/use-cases/decide-leave-request";
import { drizzleApprovalContextReader } from "./infrastructure/drizzle-approval-context.reader";
import { drizzleApprovalDirectory } from "./infrastructure/drizzle-approval-directory";
import { drizzleApprovalInbox } from "./infrastructure/drizzle-approval-inbox";
import * as pending from "./infrastructure/drizzle-pending-requests";
import { leaveApprovalChangeLog, leaveApprovalRequests } from "./infrastructure/leave-adapters";

/** Every port on Drizzle, bound to `ex` (the pool, or one transaction). */
export function approvalStore(ex: Executor): ApprovalStore {
  return {
    requests: leaveApprovalRequests(ex),
    contexts: drizzleApprovalContextReader(ex),
    directory: drizzleApprovalDirectory(ex),
    changes: leaveApprovalChangeLog(ex as Transaction),
    inbox: drizzleApprovalInbox(ex),
  };
}

/** The use cases' dependencies for one service call. */
export function approvalDeps(ctx: ServiceContext): ApprovalDeps {
  return {
    linkKey: ctx.linkKey,
    appUrl: ctx.appUrl,
    now: () => ctx.now(),
    read: approvalStore(ctx.db),
    unitOfWork: (companyId, work) => commitThenNotify(ctx, companyId, (tx) => work(approvalStore(tx))),
  };
}

export const decideLeaveRequest = (ctx: ServiceContext, actor: Actor, input: DecideInput) => decide(approvalDeps(ctx), actor, input);
export const getApprovalTriage = (ctx: ServiceContext, actor: Actor, options?: { view?: ApprovalsView; page?: PageCursor; size?: number }) =>
  triage(approvalDeps(ctx), actor, options);
export const getApprovalNav = (ctx: ServiceContext, actor: Actor) => nav(approvalDeps(ctx), actor);
export const readEmailApproval = (ctx: ServiceContext, token: string) => readLink(approvalDeps(ctx), token);
export const approveFromEmail = (ctx: ServiceContext, token: string) => approveLink(approvalDeps(ctx), token);

/** The Approve link for a request email to `approverId`, or `null` where links cannot be signed. */
export const approveLinkFor = (ctx: ServiceContext, requestId: string, approverId: string) => signApproveLink(ctx, requestId, approverId);

/**
 * Re-routes pending requests after an admin change, inside that change's transaction
 * `tx` (which holds `lockCompany`): see `reroutePending`. Send the returned emails after commit.
 */
export function rerouteApprovals(ctx: ServiceContext, tx: Transaction, actor: Actor, requests: readonly LeaveRequest[]): Promise<Rerouted> {
  return reroutePending(approvalDeps(ctx), approvalStore(tx), actor, requests);
}

/** The approval rule's inputs for each requester, read in `ex`: the one routing loader. */
export function loadApprovalContexts(ex: Executor, companyId: string, requesters: readonly RoutingRequester[]) {
  return drizzleApprovalContextReader(ex).contextsFor(companyId, requesters);
}

/** Pending requests of the company assigned to `approverId`, other than their own, oldest first. */
export const listPendingAssignedTo = (ex: Executor, companyId: string, approverId: string) => pending.listPendingAssignedTo(ex, companyId, approverId);
/** A person's own pending requests, whoever they wait on, oldest first. */
export const listPendingRequestsOf = (ex: Executor, companyId: string, userId: string) => pending.listPendingRequestsOf(ex, companyId, userId);
/** Pending requests from anyone in the department (active or not), oldest first. */
export const listPendingRequestsInDepartment = (ex: Executor, companyId: string, departmentId: string) =>
  pending.listPendingRequestsInDepartment(ex, companyId, departmentId);
/** The company's pending requests routed to their own requester (an admin with nobody else to ask), oldest first. */
export const listPendingSelfRouted = (ex: Executor, companyId: string) => pending.listPendingSelfRouted(ex, companyId);

/**
 * Leave's `ApprovalRouter` port, served by approval routing. The composition root hands
 * it to leave (`provideApprovalRouting`), so leave never imports approvals.
 */
export const leaveApprovalRouting: ApprovalRouting = {
  router: (ex) => {
    const reader = drizzleApprovalContextReader(ex);
    return {
      route: (companyId, requester, mode) => routeRequest(reader, companyId, requester, mode),
      currentApprover: (companyId, requesterId) => currentApprover(reader, companyId, requesterId),
    };
  },
  approveLink: (ctx, requestId, approverId) => signApproveLink(ctx, requestId, approverId),
};

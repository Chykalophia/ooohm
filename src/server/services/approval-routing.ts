/**
 * Who decides a request, read from the database: the inputs the approval rule needs,
 * and re-routing pending requests when an admin change moves the right to decide them.
 */
import type { Executor, Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { type ApprovalContext, type ApprovalRequester, ManagerApprovalRule, reassignApprover } from "@/domain/approval-rule";
import type { ServiceContext } from "@/server/context";
import { findDepartmentManagerIds } from "@/server/repositories/departments";
import { type LeaveRequestRow, reassignIfCurrent } from "@/server/repositories/leave-requests";
import { listAllLeaveTypes } from "@/server/repositories/leave-types";
import { findMembers, listActiveAdmins } from "@/server/repositories/users";
import { approveLinkFor } from "./email-approval";
import { activeContacts, recordReassignment, summarize } from "./leave-changes";
import type { Notification } from "./notify";

/** A requester as the approval rule needs them: who they are, and who might decide for them. */
export interface ApprovalRequesterRow extends ApprovalRequester {
  departmentId: string | null;
}

/**
 * What the approval rule needs to route each of `requesters`, read in `ex` (inside the
 * deciding or re-routing transaction, so it reflects who is active and who manages
 * whom now), by requester id: their manager, their department's manager and the
 * company's active admins.
 *
 * Four queries at most whatever the number of requesters: the admins, the department
 * managers' ids, then every manager at once. Being one's own manager (directly or as
 * the department's) is ignored, as the rule ignores it.
 */
export async function loadApprovalContexts(
  ex: Executor,
  companyId: string,
  requesters: readonly ApprovalRequesterRow[],
): Promise<Map<string, ApprovalContext>> {
  const departmentIds = [...new Set(requesters.flatMap((r) => (r.departmentId ? [r.departmentId] : [])))];
  const [admins, departmentManagers] = await Promise.all([
    listActiveAdmins(ex, companyId),
    findDepartmentManagerIds(ex, companyId, departmentIds),
  ]);
  const managerIds = new Set(requesters.flatMap((r) => (r.managerId ? [r.managerId] : [])));
  for (const id of departmentManagers.values()) managerIds.add(id);
  const managers = new Map((await findMembers(ex, companyId, [...managerIds])).map((m) => [m.id, m]));

  const candidate = (id: string | null | undefined, requesterId: string) => (id && id !== requesterId ? (managers.get(id) ?? null) : null);
  return new Map(
    requesters.map((requester) => [
      requester.id,
      {
        requester,
        manager: candidate(requester.managerId, requester.id),
        departmentManager: candidate(requester.departmentId ? departmentManagers.get(requester.departmentId) : null, requester.id),
        admins,
      },
    ]),
  );
}

/** {@link loadApprovalContexts} for one requester. */
export async function loadApprovalContext(ex: Executor, companyId: string, requester: ApprovalRequesterRow): Promise<ApprovalContext> {
  return (await loadApprovalContexts(ex, companyId, [requester])).get(requester.id)!;
}

/**
 * Re-routes pending requests to the approver {@link reassignApprover} now picks for
 * each requester (read after the change that prompted it, inside `tx`): their active
 * manager, else their department's active manager, else the longest-standing other active admin, else the requester themself
 * when they are an admin; never self-approval. A request the rule would leave with the
 * approver it already has is left alone (so an only admin's request routed to themself
 * stays put); one nobody can take keeps no assigned approver, and every admin still
 * sees it in their inbox.
 *
 * Each move is compare-and-set on the request's current approver, writes
 * `leave_request.reassigned` and `leave.reassigned`, and queues a review email to the
 * new approver. Reads are batched (requesters, {@link loadApprovalContexts}, contacts
 * and leave types: seven queries at most, whatever the number of requests), so the caller's
 * company lock is held for one update and its audit rows per moved request.
 */
export async function rerouteApprovals(ctx: ServiceContext, tx: Transaction, actor: Actor, requests: readonly LeaveRequestRow[]) {
  const pending = [...new Map(requests.map((r) => [r.id, r])).values()];
  if (pending.length === 0) return { reassigned: 0, notify: [] as Notification[] };
  const requesters = await findMembers(tx, actor.companyId, [...new Set(pending.map((r) => r.userId))]);
  const contexts = await loadApprovalContexts(tx, actor.companyId, requesters);
  const rule = new ManagerApprovalRule();

  const moves = pending.flatMap((request) => {
    const context = contexts.get(request.userId);
    if (!context) return [];
    const approverId = reassignApprover(rule, context);
    return approverId === request.approverId ? [] : [{ request, approverId }];
  });
  if (moves.length === 0) return { reassigned: 0, notify: [] as Notification[] };

  const [contacts, leaveTypes] = await Promise.all([
    activeContacts(tx, actor.companyId, moves.flatMap(({ request, approverId }) => [request.userId, approverId])),
    listAllLeaveTypes(tx, actor.companyId).then((rows) => new Map(rows.map((t) => [t.id, t.name]))),
  ]);
  const notify: Notification[] = [];
  let reassigned = 0;
  for (const { request, approverId } of moves) {
    const after = await reassignIfCurrent(tx, { companyId: actor.companyId, id: request.id, from: request.approverId }, approverId);
    if (!after) continue;
    await recordReassignment(tx, { before: request, after, source: actor.source });
    reassigned++;

    const approver = approverId && approverId !== request.userId ? contacts.get(approverId) : undefined;
    if (!approver) continue;
    const leave = summarize(after, contacts.get(request.userId), leaveTypes.get(after.leaveTypeId) ?? "Time off");
    notify.push({
      type: "leave.requested",
      to: approver.email,
      data: {
        requestId: after.id,
        recipientName: approver.name,
        leave,
        link: `${ctx.appUrl}/approvals`,
        approveLink: approveLinkFor(ctx, after.id, approver.id),
      },
    });
  }
  return { reassigned, notify };
}

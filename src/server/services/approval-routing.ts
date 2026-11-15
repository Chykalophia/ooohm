import "server-only";
/**
 * Who decides a request, read from the database: the inputs the approval rule needs.
 * Re-routing pending requests when an admin change moves the right to decide them is
 * in `approval-reroute.ts`.
 */
import type { Executor } from "@/db/types";
import { type ApprovalContext, type ApprovalRequester, ManagerApprovalRule, reassignApprover } from "@/domain/approval-rule";
import { findDepartmentManagerIds } from "@/modules/organisation";
import { findMember, findMembers, listActiveAdmins } from "@/server/repositories/users";

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
 * Who the approval rule (minus self-approval) picks for `requesterId`'s pending
 * requests now, read inside `ex`: five reads at most. Also who is told when someone
 * cancels heads-up time off.
 */
export async function currentApprover(ex: Executor, companyId: string, requesterId: string): Promise<string | null> {
  const requester = await findMember(ex, companyId, requesterId);
  if (!requester) return null;
  return reassignApprover(new ManagerApprovalRule(), await loadApprovalContext(ex, companyId, requester));
}

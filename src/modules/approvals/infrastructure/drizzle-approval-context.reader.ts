import "server-only";
/**
 * Who decides a request, read from the database: the inputs the approval rule needs.
 * This is the one routing loader (AGENTS.md); everything that routes reads through it.
 */
import type { Executor } from "@/db/types";
import { findDepartmentManagerIds } from "@/modules/organisation";
import { findMembers, listActiveAdmins } from "@/shared/lib/db/members";
import type { ApprovalContextReader, RoutingRequester } from "../application/ports";
import type { ApprovalContext } from "../domain/approval-context";

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
  requesters: readonly RoutingRequester[],
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
export async function loadApprovalContext(ex: Executor, companyId: string, requester: RoutingRequester): Promise<ApprovalContext> {
  return (await loadApprovalContexts(ex, companyId, [requester])).get(requester.id)!;
}

/** The {@link ApprovalContextReader} on Drizzle, bound to `ex`. */
export function drizzleApprovalContextReader(ex: Executor): ApprovalContextReader {
  return {
    requesters: (companyId, ids) => findMembers(ex, companyId, ids),
    contextsFor: (companyId, requesters) => loadApprovalContexts(ex, companyId, requesters),
  };
}

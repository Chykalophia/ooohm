import "server-only";
/**
 * Setting a department's manager, with what it does to approvals already waiting.
 *
 * The department belongs to the organisation module (`changeDepartmentManager`); who
 * decides a request belongs to approval routing, which reads organisation. This use case
 * joins the two in one transaction, so organisation never depends on approvals or on email.
 */
import type { Actor } from "@/domain/actor";
import { isUuid } from "@/domain/ids";
import type { ServiceContext } from "@/server/context";
import { listPendingRequestsInDepartment } from "@/server/repositories/leave-requests";
import { canManageDepartments, changeDepartmentManager, type DepartmentDTO } from "@/modules/organisation";
import { commitThenNotify } from "@/modules/notifications";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { rerouteApprovals } from "./approval-reroute";

/** What setting a department's manager did. */
export interface DepartmentManagerResult extends DepartmentDTO {
  /** Pending requests from the department's people that now wait on someone else. */
  requestsReassigned: number;
}

/**
 * Sets (or, with `null`, clears) the department's manager: any active member of the
 * company, whatever their role, since managing people is the reporting line and not
 * the role. Setting the manager it already has changes and records nothing.
 *
 * The department manager approves for its people who have no active manager of their
 * own, so the change re-routes the department's pending requests in the same
 * transaction (see `rerouteApprovals`): a request the rule now gives to someone else
 * moves, with its audit row, event and review email to the new approver after commit.
 * Taken under the company lock, as every change that moves approvals is.
 *
 * Fails with `forbidden`, `not_found`, `no_company`, or `invalid_manager` (not an active
 * member of the company).
 */
export async function setDepartmentManager(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  managerId: string | null,
): Promise<ServiceResult<DepartmentManagerResult>> {
  if (!canManageDepartments(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(() =>
    commitThenNotify(ctx, actor.companyId, async (tx) => {
      const { department, changed } = await changeDepartmentManager(tx, actor, id, managerId);
      if (!changed) return { result: { ...department, requestsReassigned: 0 }, notify: [] };
      const { reassigned, notify } = await rerouteApprovals(ctx, tx, actor, await listPendingRequestsInDepartment(tx, actor.companyId, id));
      return { result: { ...department, requestsReassigned: reassigned }, notify };
    }),
  );
}

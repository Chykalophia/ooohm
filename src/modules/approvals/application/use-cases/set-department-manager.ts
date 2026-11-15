import "server-only";
/**
 * Setting a department's manager, with what it does to approvals already waiting.
 *
 * The department belongs to the organisation module (its `changeDepartmentManager`
 * step); who decides a request belongs to approval routing, which reads organisation.
 * This use case joins the two in one unit of work, so organisation never depends on
 * approvals or on email.
 */
import type { Actor } from "@/shared/kernel/actor";
import { isUuid } from "@/shared/kernel/uuid";
import type { LeaveRequest } from "@/modules/leave";
import type { Notification } from "@/modules/notifications";
import { canManageDepartments, type DepartmentDTO, type DepartmentManagerChange } from "@/modules/organisation";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import type { ApprovalDeps, ApprovalStore } from "../ports";
import { reroutePending } from "../reroute-pending";

/** Organisation's department step and the department's pending requests, bound to the unit of work's transaction. */
export interface DepartmentManagerSteps {
  change(actor: Actor, id: string, managerId: string | null): Promise<DepartmentManagerChange>;
  /** Pending requests from anyone in the department (active or not), oldest first. */
  pendingInDepartment(companyId: string, departmentId: string): Promise<LeaveRequest[]>;
}

/** What {@link setDepartmentManager} needs: approvals' dependencies and one transaction holding every step. */
export interface SetDepartmentManagerDeps {
  approvals: ApprovalDeps;
  /** Runs `work` in one transaction with the steps and approvals' ports bound to it; its emails go out after commit. */
  unitOfWork<T>(companyId: string, work: (steps: DepartmentManagerSteps, store: ApprovalStore) => Promise<{ result: T; notify: Notification[] }>): Promise<T>;
}

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
 * transaction (see `reroutePending`): a request the rule now gives to someone else
 * moves, with its audit row, event and review email to the new approver after commit.
 * Taken under the company lock, as every change that moves approvals is.
 *
 * Fails with `forbidden`, `not_found`, `no_company`, or `invalid_manager` (not an active
 * member of the company).
 */
export async function setDepartmentManager(
  deps: SetDepartmentManagerDeps,
  actor: Actor,
  id: string,
  managerId: string | null,
): Promise<ServiceResult<DepartmentManagerResult>> {
  if (!canManageDepartments(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(() =>
    deps.unitOfWork(actor.companyId, async (steps, store) => {
      const { department, changed } = await steps.change(actor, id, managerId);
      if (!changed) return { result: { ...department, requestsReassigned: 0 }, notify: [] };
      const { reassigned, notify } = await reroutePending(deps.approvals, store, actor, await steps.pendingInDepartment(actor.companyId, id));
      return { result: { ...department, requestsReassigned: reassigned }, notify };
    }),
  );
}

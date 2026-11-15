import "server-only";
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { findMember } from "@/shared/lib/db/members";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { lockDepartment, setDepartmentManagerRow } from "@/modules/organisation/infrastructure/drizzle-departments.repository";
import { departmentPayload } from "@/modules/organisation/application/department-changes";
import { type DepartmentDTO, toDepartmentDTO } from "@/modules/organisation/application/dto";

/** What setting a department's manager did. `changed` is false (nothing written or recorded) when it already had that manager. */
export interface DepartmentManagerChange {
  department: DepartmentDTO;
  changed: boolean;
}

/**
 * Inside the caller's transaction: sets (or, with `null`, clears) the department's
 * manager, any active member of the company whatever their role, and records
 * `department.manager_changed`. Takes the company lock first, as every change that
 * moves approvals does, then checks the actor is still an active admin.
 *
 * The caller checks the actor first (`canManageDepartments`) and re-routes the
 * department's pending requests in the same transaction when `changed`.
 *
 * @throws DomainError `no_company`, `forbidden`, `not_found`, or `invalid_manager` (not
 *   an active member of the company).
 */
export async function changeDepartmentManager(tx: Transaction, actor: Actor, id: string, managerId: string | null): Promise<DepartmentManagerChange> {
  if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
  await assertActiveAdmin(tx, actor);
  const before = await lockDepartment(tx, actor.companyId, id);
  if (!before) throw new DomainError("not_found");
  // Unchanged is fine even for a manager since deactivated, so a form saved as it was never fails.
  if (before.managerId === managerId) return { department: toDepartmentDTO(before), changed: false };
  if (managerId !== null && !(await findMember(tx, actor.companyId, managerId))?.isActive) throw new DomainError("invalid_manager");

  const after = await setDepartmentManagerRow(tx, actor.companyId, id, managerId);
  await recordAdminChange(tx, actor, {
    type: ADMIN_EVENT_TYPES.departmentManagerChanged,
    entityType: "department",
    entityId: id,
    before: { managerId: before.managerId },
    after: { managerId: after.managerId },
    payload: departmentPayload(after),
  });
  return { department: toDepartmentDTO(after), changed: true };
}

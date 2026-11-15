import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import type { ServiceContext } from "@/server/context";
import { countDepartmentMembers } from "@/server/repositories/users";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { deleteDepartment as deleteDepartmentRow, lockDepartment } from "@/modules/organisation/infrastructure/drizzle-departments.repository";
import { removeRulesOf } from "@/modules/organisation/application/allowance-rule-removal";
import { departmentPayload } from "@/modules/organisation/application/department-changes";
import { canManageDepartments } from "@/modules/organisation/application/policies";

/**
 * Deletes an empty department. One with people in it (active or not) is refused rather
 * than emptied: emptying it would change each of those people with no audit row of
 * their own. Move them first; that is audited per person. Its allowance rules go with
 * it, each recorded as removed.
 *
 * The department row is locked first, so nobody can be moved into it between the
 * emptiness check and the delete.
 *
 * Fails with `forbidden`, `not_found`, `no_company`, or `department_not_empty`.
 */
export async function deleteDepartment(ctx: ServiceContext, actor: Actor, id: string): Promise<ServiceResult<void>> {
  if (!canManageDepartments(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(() =>
    inTransaction(ctx, async (tx) => {
      // The company lock first, as rule changes take it, so a rule removed here is removed once.
      if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
      await assertActiveAdmin(tx, actor);
      const before = await lockDepartment(tx, actor.companyId, id);
      if (!before) throw new DomainError("not_found");
      if ((await countDepartmentMembers(tx, id)) > 0) throw new DomainError("department_not_empty");
      await removeRulesOf(tx, actor, { departmentId: id });
      await deleteDepartmentRow(tx, actor.companyId, id);
      await recordAdminChange(tx, actor, {
        type: ADMIN_EVENT_TYPES.departmentDeleted,
        entityType: "department",
        entityId: id,
        before: { name: before.name },
        after: null,
        payload: departmentPayload(before),
      });
    }),
  );
}

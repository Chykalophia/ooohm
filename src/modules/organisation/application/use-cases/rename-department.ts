import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import { isUuid } from "@/shared/kernel/uuid";
import { normalizeDepartmentName } from "@/shared/kernel/names";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import {
  findDepartmentByName,
  lockDepartment,
  renameDepartment as renameDepartmentRow,
} from "@/modules/organisation/infrastructure/drizzle-departments.repository";
import { departmentPayload, withUniqueDepartmentName } from "@/modules/organisation/application/department-changes";
import { type DepartmentDTO, toDepartmentDTO } from "@/modules/organisation/application/dto";
import { canManageDepartments } from "@/modules/organisation/application/policies";

/**
 * Renames a department; the same name again changes nothing. Fails with `forbidden`,
 * `not_found`, `invalid_input`, or `already_exists`.
 */
export async function renameDepartment(ctx: ServiceContext, actor: Actor, id: string, rawName: string): Promise<ServiceResult<DepartmentDTO>> {
  if (!canManageDepartments(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(async () => {
    const name = normalizeDepartmentName(rawName);
    return withUniqueDepartmentName(() =>
      inTransaction(ctx, actor.companyId, async (tx) => {
        await assertActiveAdmin(tx, actor);
        const before = await lockDepartment(tx, actor.companyId, id);
        if (!before) throw new DomainError("not_found");
        if (before.name === name) return toDepartmentDTO(before);
        if (await findDepartmentByName(tx, actor.companyId, name, id)) throw new DomainError("already_exists");
        const after = await renameDepartmentRow(tx, actor.companyId, id, name);
        await recordAdminChange(tx, actor, {
          type: ADMIN_EVENT_TYPES.departmentRenamed,
          entityType: "department",
          entityId: id,
          before: { name: before.name },
          after: { name: after.name },
          payload: departmentPayload(after),
        });
        return toDepartmentDTO(after);
      }),
    );
  });
}

import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { normalizeDepartmentName } from "@/domain/people";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { findDepartmentByName, insertDepartment } from "@/modules/organisation/infrastructure/drizzle-departments.repository";
import { departmentPayload, withUniqueDepartmentName } from "@/modules/organisation/application/department-changes";
import { type DepartmentDTO, toDepartmentDTO } from "@/modules/organisation/application/dto";
import { canManageDepartments } from "@/modules/organisation/application/policies";

/**
 * Adds a department: a name people can be grouped by (the team view filters on it).
 * Fails with `forbidden`, `invalid_input`, or `already_exists` (the same name, ignoring case).
 */
export async function createDepartment(ctx: ServiceContext, actor: Actor, rawName: string): Promise<ServiceResult<DepartmentDTO>> {
  if (!canManageDepartments(actor)) return err("forbidden");
  return attempt(async () => {
    const name = normalizeDepartmentName(rawName);
    return withUniqueDepartmentName(() =>
      inTransaction(ctx, async (tx) => {
        await assertActiveAdmin(tx, actor);
        if (await findDepartmentByName(tx, actor.companyId, name)) throw new DomainError("already_exists");
        const row = await insertDepartment(tx, { companyId: actor.companyId, name });
        await recordAdminChange(tx, actor, {
          type: ADMIN_EVENT_TYPES.departmentCreated,
          entityType: "department",
          entityId: row.id,
          before: null,
          after: { name: row.name },
          payload: departmentPayload(row),
        });
        return toDepartmentDTO(row);
      }),
    );
  });
}

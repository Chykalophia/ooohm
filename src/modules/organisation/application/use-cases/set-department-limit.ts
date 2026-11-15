import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import { isUuid } from "@/shared/kernel/uuid";
import type { ServiceContext } from "@/server/context";
import { MAX_OFF_LIMIT } from "@/shared/kernel/coverage-limit";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { lockDepartment, setDepartmentMaxOffRow } from "@/modules/organisation/infrastructure/drizzle-departments.repository";
import { departmentPayload } from "@/modules/organisation/application/department-changes";
import { type DepartmentDTO, toDepartmentDTO } from "@/modules/organisation/application/dto";
import { canManageDepartments } from "@/modules/organisation/application/policies";

/**
 * Sets (or, with `null`, clears) the department's coverage limit: at most `maxOff` of its
 * people off on one working day. It only ever warns, the requester before sending and the
 * approver before deciding, so nothing already booked or waiting changes. Setting the
 * limit it already has changes and records nothing.
 *
 * Fails with `forbidden`, `not_found`, or `invalid_input` (not a whole number from 1 to
 * {@link MAX_OFF_LIMIT}).
 */
export async function setDepartmentLimit(ctx: ServiceContext, actor: Actor, id: string, maxOff: number | null): Promise<ServiceResult<DepartmentDTO>> {
  if (!canManageDepartments(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  if (maxOff !== null && (!Number.isInteger(maxOff) || maxOff < 1 || maxOff > MAX_OFF_LIMIT)) return err("invalid_input");
  return attempt(() =>
    inTransaction(ctx, async (tx) => {
      await assertActiveAdmin(tx, actor);
      const before = await lockDepartment(tx, actor.companyId, id);
      if (!before) throw new DomainError("not_found");
      if (before.maxOff === maxOff) return toDepartmentDTO(before);
      const after = await setDepartmentMaxOffRow(tx, actor.companyId, id, maxOff);
      await recordAdminChange(tx, actor, {
        type: ADMIN_EVENT_TYPES.departmentLimitChanged,
        entityType: "department",
        entityId: id,
        before: { maxOff: before.maxOff },
        after: { maxOff: after.maxOff },
        payload: departmentPayload(after),
      });
      return toDepartmentDTO(after);
    }),
  );
}

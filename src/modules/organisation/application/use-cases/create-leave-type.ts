import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import { type LeaveTypeSettings, normalizeLeaveTypeSettings } from "@/shared/kernel/leave-type-settings";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import {
  insertLeaveType,
  leaveTypeCodeTaken,
  nextLeaveTypeSortOrder,
} from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";
import { recordLeaveTypeChange, withUniqueCode } from "@/modules/organisation/application/leave-type-changes";
import { canManageLeaveTypes } from "@/modules/organisation/application/policies";

/**
 * Creates a leave type, last in the request form's order. Fails with `forbidden`,
 * `no_company`, `invalid_input`, or `already_exists` (the code is taken).
 */
export async function createLeaveType(ctx: ServiceContext, actor: Actor, input: LeaveTypeSettings): Promise<ServiceResult<LeaveTypeSettingsDTO>> {
  if (!canManageLeaveTypes(actor)) return err("forbidden");
  return attempt(async () => {
    const settings = normalizeLeaveTypeSettings(input);
    return withUniqueCode(() =>
      inTransaction(ctx, async (tx) => {
        // Serialises creates, so two cannot take the same next sort order.
        if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
        await assertActiveAdmin(tx, actor);
        if (await leaveTypeCodeTaken(tx, actor.companyId, settings.code)) throw new DomainError("already_exists");
        const sortOrder = await nextLeaveTypeSortOrder(tx, actor.companyId);
        const row = toLeaveTypeSettingsDTO(await insertLeaveType(tx, { companyId: actor.companyId, sortOrder, ...settings }));
        await recordLeaveTypeChange(tx, actor, ADMIN_EVENT_TYPES.leaveTypeCreated, null, row);
        return row;
      }),
    );
  });
}

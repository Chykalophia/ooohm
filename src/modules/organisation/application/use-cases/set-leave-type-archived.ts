import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import { isUuid } from "@/shared/kernel/uuid";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { findLeaveTypeForAdmin, nextLeaveTypeSortOrder } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";
import { applyLeaveTypeChanges } from "@/modules/organisation/application/steps/apply-leave-type-changes";
import { recordLeaveTypeChange } from "@/modules/organisation/application/leave-type-changes";
import { canManageLeaveTypes } from "@/modules/organisation/application/policies";

/**
 * Archives (`archived: true`) or restores a leave type. Types are never deleted: requests
 * and allowances reference them, and history must keep its names. Archived types leave
 * the request form; history, calendars and balances with an allowance or booked days
 * keep showing them, and the year rollover skips them. A restored type goes last.
 *
 * Returns the type after the change (unchanged, with nothing recorded, when already so).
 * Fails with `forbidden`, `no_company`, or `not_found`.
 */
export async function setLeaveTypeArchived(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  archived: boolean,
): Promise<ServiceResult<LeaveTypeSettingsDTO>> {
  if (!canManageLeaveTypes(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(() =>
    inTransaction(ctx, actor.companyId, async (tx) => {
      if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
      await assertActiveAdmin(tx, actor);
      const found = await findLeaveTypeForAdmin(tx, actor.companyId, id);
      if (!found) throw new DomainError("not_found");
      const before = toLeaveTypeSettingsDTO(found);
      if ((before.archivedAt !== null) === archived) return before;
      const after = archived
        ? await applyLeaveTypeChanges(tx, actor.companyId, id, { archivedAt: ctx.now() })
        : await applyLeaveTypeChanges(tx, actor.companyId, id, {
            archivedAt: null,
            sortOrder: await nextLeaveTypeSortOrder(tx, actor.companyId),
          });
      await recordLeaveTypeChange(tx, actor, archived ? ADMIN_EVENT_TYPES.leaveTypeArchived : ADMIN_EVENT_TYPES.leaveTypeUnarchived, before, after);
      return after;
    }),
  );
}

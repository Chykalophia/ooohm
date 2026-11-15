import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { type LeaveTypeSettings, normalizeLeaveTypeSettings } from "@/domain/leave-type-settings";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import {
  findLeaveTypeForAdmin,
  leaveTypeCodeTaken,
  updateLeaveType as updateLeaveTypeRow,
} from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";
import { recordLeaveTypeChange, withUniqueCode } from "@/modules/organisation/application/leave-type-changes";
import { canManageLeaveTypes } from "@/modules/organisation/application/policies";

/**
 * Replaces a leave type's settings. Changing the code renames it on calendars and feeds;
 * changing a balance setting changes every balance computed from now on.
 *
 * Returns the type after the change (unchanged, with nothing recorded, when nothing
 * differs). Fails with `forbidden`, `not_found`, `invalid_input`, or `already_exists`.
 */
export async function updateLeaveType(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  input: LeaveTypeSettings,
): Promise<ServiceResult<LeaveTypeSettingsDTO>> {
  if (!canManageLeaveTypes(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(async () => {
    const settings = normalizeLeaveTypeSettings(input);
    return withUniqueCode(() =>
      inTransaction(ctx, async (tx) => {
        await assertActiveAdmin(tx, actor);
        const found = await findLeaveTypeForAdmin(tx, actor.companyId, id);
        if (!found) throw new DomainError("not_found");
        const before = toLeaveTypeSettingsDTO(found);
        const changed = (Object.keys(settings) as (keyof LeaveTypeSettings)[]).some((k) => settings[k] !== before[k]);
        if (!changed) return before;
        if (settings.code !== before.code && (await leaveTypeCodeTaken(tx, actor.companyId, settings.code, id))) {
          throw new DomainError("already_exists");
        }
        const after = toLeaveTypeSettingsDTO(await updateLeaveTypeRow(tx, actor.companyId, id, settings));
        await recordLeaveTypeChange(tx, actor, ADMIN_EVENT_TYPES.leaveTypeUpdated, before, after);
        return after;
      }),
    );
  });
}

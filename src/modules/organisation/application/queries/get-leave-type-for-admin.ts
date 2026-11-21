import "server-only";
import { forTenant } from "@/shared/lib/tenant";
import type { Actor } from "@/shared/kernel/actor";
import { isUuid } from "@/shared/kernel/uuid";
import type { ServiceContext } from "@/server/context";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import { findLeaveTypeForAdmin } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";
import { canManageLeaveTypes } from "@/modules/organisation/application/policies";

/** One leave type with every setting, for its edit screen. Fails with `forbidden` or `not_found`. */
export async function getLeaveTypeForAdmin(ctx: ServiceContext, actor: Actor, id: string): Promise<ServiceResult<LeaveTypeSettingsDTO>> {
  if (!canManageLeaveTypes(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  ctx = forTenant(ctx, actor.companyId);
  const row = await findLeaveTypeForAdmin(ctx.db, actor.companyId, id);
  return row ? ok(toLeaveTypeSettingsDTO(row)) : err("not_found");
}

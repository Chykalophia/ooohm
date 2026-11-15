import "server-only";
import { forTenant } from "@/shared/lib/tenant";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import { listAllLeaveTypes } from "@/modules/organisation/infrastructure/drizzle-leave-types.repository";
import { type LeaveTypeSettingsDTO, toLeaveTypeSettingsDTO } from "@/modules/organisation/application/dto";
import { canManageLeaveTypes } from "@/modules/organisation/application/policies";

/** Every leave type of the company: active ones in request-form order, then archived. Fails with `forbidden` for a non-admin. */
export async function listLeaveTypesForAdmin(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<LeaveTypeSettingsDTO[]>> {
  if (!canManageLeaveTypes(actor)) return err("forbidden");
  ctx = forTenant(ctx, actor.companyId);
  return ok((await listAllLeaveTypes(ctx.db, actor.companyId)).map(toLeaveTypeSettingsDTO));
}

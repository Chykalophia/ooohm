import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import type { RecountOutcome } from "@/modules/leave";
import type { ServiceResult } from "@/shared/lib/result";
import { deleteHolidays } from "@/modules/holidays/application/use-cases/delete-holidays";

/** Deletes one holiday and recounts the requests on its date. Fails as {@link deleteHolidays}. */
export async function deleteHoliday(ctx: ServiceContext, actor: Actor, id: string): Promise<ServiceResult<RecountOutcome>> {
  return deleteHolidays(ctx, actor, [id]);
}

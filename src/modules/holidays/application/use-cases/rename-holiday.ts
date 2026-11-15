import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import type { HolidayDTO } from "@/modules/holidays/application/dto";
import { renameHolidays } from "@/modules/holidays/application/use-cases/rename-holidays";

/** Renames one holiday, audited. Fails as {@link renameHolidays}. */
export async function renameHoliday(ctx: ServiceContext, actor: Actor, id: string, rawName: string): Promise<ServiceResult<HolidayDTO>> {
  const result = await renameHolidays(ctx, actor, [id], rawName);
  if (!result.ok) return result;
  const [holiday] = result.value;
  return holiday ? ok(holiday) : err("not_found");
}

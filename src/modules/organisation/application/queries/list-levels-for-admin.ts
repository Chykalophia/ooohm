import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import { listLevelsWithCounts } from "@/modules/organisation/infrastructure/drizzle-levels.repository";
import { type LevelSummaryDTO, toLevelSummaryDTO } from "@/modules/organisation/application/dto";
import { canManageLevels } from "@/modules/organisation/application/policies";

/** The company's levels by name, with how many people are at each. Fails with `forbidden` for a non-admin. */
export async function listLevelsForAdmin(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<LevelSummaryDTO[]>> {
  if (!canManageLevels(actor)) return err("forbidden");
  return ok((await listLevelsWithCounts(ctx.db, actor.companyId)).map(toLevelSummaryDTO));
}

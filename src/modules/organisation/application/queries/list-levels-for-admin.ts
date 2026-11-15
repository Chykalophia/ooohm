import "server-only";
import type { Actor } from "@/domain/actor";
import type { ServiceContext } from "@/server/context";
import { err, ok, type ServiceResult } from "@/shared/lib/result";
import { listLevelsWithCounts } from "../../infrastructure/drizzle-levels.repository";
import { type LevelSummaryDTO, toLevelSummaryDTO } from "../dto";
import { canManageLevels } from "../policies";

/** The company's levels by name, with how many people are at each. Fails with `forbidden` for a non-admin. */
export async function listLevelsForAdmin(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<LevelSummaryDTO[]>> {
  if (!canManageLevels(actor)) return err("forbidden");
  return ok((await listLevelsWithCounts(ctx.db, actor.companyId)).map(toLevelSummaryDTO));
}

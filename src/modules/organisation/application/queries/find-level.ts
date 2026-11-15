import "server-only";
import type { Executor } from "@/db/types";
import { findLevel as findLevelRow } from "@/modules/organisation/infrastructure/drizzle-levels.repository";
import { type LevelDTO, toLevelDTO } from "@/modules/organisation/application/dto";

/**
 * One of the company's levels, or `undefined` when it has none with this id: how other
 * services check a level someone is placed at. Runs on the executor it is given; the
 * caller checks the actor.
 */
export async function findLevel(ex: Executor, companyId: string, id: string): Promise<LevelDTO | undefined> {
  const row = await findLevelRow(ex, companyId, id);
  return row && toLevelDTO(row);
}

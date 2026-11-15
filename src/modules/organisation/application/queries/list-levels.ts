import "server-only";
import type { Executor } from "@/db/types";
import { listLevels as listLevelRows } from "../../infrastructure/drizzle-levels.repository";
import { type LevelDTO, toLevelDTO } from "../dto";

/**
 * The company's levels by name, ignoring case (every level list and picker uses this
 * order), for other services' pickers and labels. Runs on the executor it is given, so
 * a caller inside a transaction reads what it sees; the caller checks the actor.
 */
export async function listLevels(ex: Executor, companyId: string): Promise<LevelDTO[]> {
  return (await listLevelRows(ex, companyId)).map(toLevelDTO);
}

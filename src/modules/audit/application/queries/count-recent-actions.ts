import "server-only";
import type { Executor } from "@/db/types";
import { countRecentActions as countInLog } from "@/modules/audit/infrastructure/drizzle-audit-log.repository";

/**
 * How many audit rows with one of `actions` the actor wrote in the company in the last
 * `minutes`, on the database clock that stamps them: the rate limits on invites and
 * imports read it inside their own transaction. The caller checks the actor.
 *
 * @param where.via Only rows made through this process; `null` for rows made directly
 *   (no `via`). Absent counts both.
 */
export function countRecentActions(
  ex: Executor,
  where: { companyId: string; actorId: string; actions: readonly string[]; via?: string | null },
  minutes: number,
): Promise<number> {
  return countInLog(ex, where, minutes);
}

import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { normalizeLevelName } from "@/domain/people";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin, recordAdminChange } from "@/server/services/admin-access";
import { inTransaction } from "@/server/services/notify";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { findLevelByName, insertLevel } from "../../infrastructure/drizzle-levels.repository";
import { type LevelDTO, toLevelDTO } from "../dto";
import { levelPayload, withUniqueName } from "../level-changes";
import { canManageLevels } from "../policies";

/**
 * Adds a level people can be placed at (Intern, Senior), so allowance rules can give
 * them more or less time off. Fails with `forbidden`, `invalid_input`, or
 * `already_exists` (the same name, ignoring case).
 */
export async function createLevel(ctx: ServiceContext, actor: Actor, rawName: string): Promise<ServiceResult<LevelDTO>> {
  if (!canManageLevels(actor)) return err("forbidden");
  return attempt(async () => {
    const name = normalizeLevelName(rawName);
    return withUniqueName(() =>
      inTransaction(ctx, async (tx) => {
        await assertActiveAdmin(tx, actor);
        if (await findLevelByName(tx, actor.companyId, name)) throw new DomainError("already_exists");
        const row = await insertLevel(tx, { companyId: actor.companyId, name });
        await recordAdminChange(tx, actor, {
          type: ADMIN_EVENT_TYPES.levelCreated,
          entityType: "level",
          entityId: row.id,
          before: null,
          after: { name: row.name },
          payload: levelPayload(row),
        });
        return toLevelDTO(row);
      }),
    );
  });
}

import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { normalizeLevelName } from "@/domain/people";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { findLevelByName, lockLevel, renameLevel as renameLevelRow } from "@/modules/organisation/infrastructure/drizzle-levels.repository";
import { type LevelDTO, toLevelDTO } from "@/modules/organisation/application/dto";
import { levelPayload, withUniqueName } from "@/modules/organisation/application/level-changes";
import { canManageLevels } from "@/modules/organisation/application/policies";

/**
 * Renames a level; the same name again changes nothing. Fails with `forbidden`,
 * `not_found`, `invalid_input`, or `already_exists`.
 */
export async function renameLevel(ctx: ServiceContext, actor: Actor, id: string, rawName: string): Promise<ServiceResult<LevelDTO>> {
  if (!canManageLevels(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(async () => {
    const name = normalizeLevelName(rawName);
    return withUniqueName(() =>
      inTransaction(ctx, async (tx) => {
        await assertActiveAdmin(tx, actor);
        const before = await lockLevel(tx, actor.companyId, id);
        if (!before) throw new DomainError("not_found");
        if (before.name === name) return toLevelDTO(before);
        if (await findLevelByName(tx, actor.companyId, name, id)) throw new DomainError("already_exists");
        const after = await renameLevelRow(tx, actor.companyId, id, name);
        await recordAdminChange(tx, actor, {
          type: ADMIN_EVENT_TYPES.levelRenamed,
          entityType: "level",
          entityId: id,
          before: { name: before.name },
          after: { name: after.name },
          payload: levelPayload(after),
        });
        return toLevelDTO(after);
      }),
    );
  });
}

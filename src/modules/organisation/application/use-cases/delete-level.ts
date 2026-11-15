import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import type { ServiceContext } from "@/server/context";
import { lockCompany } from "@/server/repositories/companies";
import { countLevelMembers } from "@/server/repositories/users";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { removeRulesOf } from "@/server/services/allowance-rule-removal";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { deleteLevel as deleteLevelRow, lockLevel } from "../../infrastructure/drizzle-levels.repository";
import { levelPayload } from "../level-changes";
import { canManageLevels } from "../policies";

/**
 * Deletes a level nobody is at. Its allowance rules go with it, each recorded as
 * removed; that changes nobody's allowance. One with people at it is refused, as for
 * departments: move them first, which is audited per person.
 *
 * Fails with `forbidden`, `not_found`, `no_company`, or `level_not_empty`.
 */
export async function deleteLevel(ctx: ServiceContext, actor: Actor, id: string): Promise<ServiceResult<void>> {
  if (!canManageLevels(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(() =>
    inTransaction(ctx, async (tx) => {
      // The company lock first, as rule changes take it, so a rule removed here is removed once.
      if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
      await assertActiveAdmin(tx, actor);
      const before = await lockLevel(tx, actor.companyId, id);
      if (!before) throw new DomainError("not_found");
      if ((await countLevelMembers(tx, id)) > 0) throw new DomainError("level_not_empty");
      await removeRulesOf(tx, actor, { levelId: id });
      await deleteLevelRow(tx, actor.companyId, id);
      await recordAdminChange(tx, actor, {
        type: ADMIN_EVENT_TYPES.levelDeleted,
        entityType: "level",
        entityId: id,
        before: { name: before.name },
        after: null,
        payload: levelPayload(before),
      });
    }),
  );
}

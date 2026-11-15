import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import { isUuid } from "@/shared/kernel/uuid";
import type { ServiceContext } from "@/server/context";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { removeRulesOf } from "@/modules/organisation/application/allowance-rule-removal";
import { inTransaction } from "@/shared/lib/unit-of-work";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { countLevelMembers, deleteLevel as deleteLevelRow, lockLevel } from "@/modules/organisation/infrastructure/drizzle-levels.repository";
import { levelPayload } from "@/modules/organisation/application/level-changes";
import { canManageLevels } from "@/modules/organisation/application/policies";

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
    inTransaction(ctx, actor.companyId, async (tx) => {
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

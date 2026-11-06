/**
 * Admin use cases for levels: names people can be placed at (Intern, Senior) so
 * allowance rules can give them more or less time off. Levels are optional; a company
 * without any never sees them.
 */
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES, type LevelEventPayload, type Unattributed } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { normalizeLevelName } from "@/domain/people";
import type { ServiceContext } from "@/server/context";
import { isUniqueViolation } from "@/server/repositories/errors";
import {
  deleteLevel as deleteLevelRow,
  findLevelByName,
  insertLevel,
  type LevelRow,
  listLevelsWithCounts,
  lockLevel,
  renameLevel as renameLevelRow,
} from "@/server/repositories/levels";
import { countLevelMembers } from "@/server/repositories/users";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";
import { inTransaction } from "./notify";

function payload(row: LevelRow): Unattributed<LevelEventPayload> {
  return { levelId: row.id, name: row.name };
}

/** Runs `work`, turning a unique-name race into `already_exists`. */
async function uniqueName<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err, "levels_company_lower_name_uq")) throw new DomainError("already_exists");
    throw err;
  }
}

/**
 * The company's levels by name, with how many people (active or not) are at each.
 *
 * @throws DomainError `forbidden` for a non-admin.
 */
export async function listLevelsForAdmin(ctx: ServiceContext, actor: Actor) {
  assertCanAdminister(actor);
  return listLevelsWithCounts(ctx.db, actor.companyId);
}

/** @throws DomainError `forbidden`, `invalid_input`, or `already_exists` (same name, ignoring case). */
export async function createLevel(ctx: ServiceContext, actor: Actor, rawName: string): Promise<LevelRow> {
  assertCanAdminister(actor);
  const name = normalizeLevelName(rawName);
  return uniqueName(() =>
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
        payload: payload(row),
      });
      return row;
    }),
  );
}

/** @throws DomainError `forbidden`, `not_found`, `invalid_input`, or `already_exists`. */
export async function renameLevel(ctx: ServiceContext, actor: Actor, id: string, rawName: string): Promise<LevelRow> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  const name = normalizeLevelName(rawName);
  return uniqueName(() =>
    inTransaction(ctx, async (tx) => {
      await assertActiveAdmin(tx, actor);
      const before = await lockLevel(tx, actor.companyId, id);
      if (!before) throw new DomainError("not_found");
      if (before.name === name) return before;
      if (await findLevelByName(tx, actor.companyId, name, id)) throw new DomainError("already_exists");
      const after = await renameLevelRow(tx, actor.companyId, id, name);
      await recordAdminChange(tx, actor, {
        type: ADMIN_EVENT_TYPES.levelRenamed,
        entityType: "level",
        entityId: id,
        before: { name: before.name },
        after: { name: after.name },
        payload: payload(after),
      });
      return after;
    }),
  );
}

/**
 * Deletes a level nobody is at (its allowance rules go with it, which changes nobody's
 * allowance). One with people at it is refused, as for departments: move them first,
 * which is audited per person.
 *
 * @throws DomainError `forbidden`, `not_found`, or `level_not_empty`.
 */
export async function deleteLevel(ctx: ServiceContext, actor: Actor, id: string): Promise<void> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  await inTransaction(ctx, async (tx) => {
    await assertActiveAdmin(tx, actor);
    const before = await lockLevel(tx, actor.companyId, id);
    if (!before) throw new DomainError("not_found");
    if ((await countLevelMembers(tx, id)) > 0) throw new DomainError("level_not_empty");
    await deleteLevelRow(tx, actor.companyId, id);
    await recordAdminChange(tx, actor, {
      type: ADMIN_EVENT_TYPES.levelDeleted,
      entityType: "level",
      entityId: id,
      before: { name: before.name },
      after: null,
      payload: payload(before),
    });
  });
}

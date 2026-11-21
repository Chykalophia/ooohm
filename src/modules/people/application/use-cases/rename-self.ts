import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import type { ServiceContext } from "@/server/context";
import { recordPersonChange } from "@/modules/people/application/person-changes";
import { findPerson, lockMember, updatePerson } from "@/shared/lib/db/members";
import { normalizePersonName } from "@/shared/kernel/names";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { inTransaction } from "@/shared/lib/unit-of-work";

/**
 * Changes the actor's own display name, recorded as `user.updated` with the person as
 * the actor (the same audit row and event an admin's edit writes).
 *
 * @returns The name as saved (unchanged, with nothing recorded, when it is the same).
 *   Fails with `invalid_input` for a blank or too long name, or `forbidden` for a
 *   deactivated account.
 */
export async function renameSelf(ctx: ServiceContext, actor: Actor, rawName: string): Promise<ServiceResult<string>> {
  return attempt(async () => {
    const name = normalizePersonName(rawName);
    return inTransaction(ctx, actor.companyId, async (tx) => {
      const member = await lockMember(tx, actor.companyId, actor.id);
      if (!member?.isActive) throw new DomainError("forbidden");
      const before = await findPerson(tx, actor.companyId, actor.id);
      if (!before) throw new DomainError("forbidden");
      if (before.name === name) return name;
      const after = await updatePerson(tx, actor.companyId, actor.id, { name });
      await recordPersonChange(tx, actor, { type: ADMIN_EVENT_TYPES.userUpdated, before, after });
      return after.name;
    });
  });
}

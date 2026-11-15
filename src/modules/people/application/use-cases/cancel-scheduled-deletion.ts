import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import type { ServiceContext } from "@/server/context";
import { beginAdminChange } from "@/modules/people/application/admin-change";
import { cancelScheduledScrubIn } from "@/modules/people/application/deletion/scrub-schedule";
import { canDeletePeople } from "@/modules/people/application/policies";
import { lockPerson } from "@/shared/lib/db/members";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { inTransaction } from "@/shared/lib/unit-of-work";

/**
 * Undoes a scheduled scrub: the person stays, deactivated (`user.deletion_cancelled`).
 * Doing it when nothing is scheduled changes and records nothing.
 *
 * @returns Whether a scrub was scheduled (and now is not). Fails with `forbidden` or `not_found`.
 */
export async function cancelScheduledDeletion(ctx: ServiceContext, actor: Actor, userId: string): Promise<ServiceResult<boolean>> {
  if (!canDeletePeople(actor)) return err("forbidden");
  return attempt(() =>
    inTransaction(ctx, async (tx) => {
      await beginAdminChange(tx, actor);
      const person = await lockPerson(tx, actor.companyId, userId);
      if (!person) throw new DomainError("not_found");
      return cancelScheduledScrubIn(tx, actor, person);
    }),
  );
}

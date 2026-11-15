import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import type { ServiceContext } from "@/server/context";
import { listPendingSelfRouted, rerouteApprovals } from "@/modules/approvals";
import { commitThenNotify } from "@/modules/notifications";
import { beginAdminChange } from "@/modules/people/application/admin-change";
import { cancelScheduledScrubIn } from "@/modules/people/application/deletion/scrub-schedule";
import { type PersonDTO, toPersonDTO } from "@/modules/people/application/dto";
import { recordPersonChange } from "@/modules/people/application/person-changes";
import { canManagePeople } from "@/modules/people/application/policies";
import { lockPerson, updatePerson as updatePersonRow } from "@/shared/lib/db/members";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

/**
 * Reactivates a person: they can sign in again (with a new link; old sessions are
 * gone) and appear in approvals and calendars. Calendar links turned off at
 * deactivation stay off; they can create new ones. Requests that moved off them while
 * they were away stay where they are, except any an admin had routed to themself for
 * want of another approver: those are re-routed, so a returning admin or manager takes
 * them (see `rerouteApprovals`). A full scrub scheduled for them is cancelled
 * (`user.deletion_cancelled`), since only a deactivated person can wait for one.
 *
 * Doing it to someone already active changes and records nothing. Fails with
 * `forbidden` or `not_found`.
 */
export async function reactivatePerson(ctx: ServiceContext, actor: Actor, userId: string): Promise<ServiceResult<PersonDTO>> {
  if (!canManagePeople(actor)) return err("forbidden");
  return attempt(() =>
    commitThenNotify(ctx, actor.companyId, async (tx) => {
      await beginAdminChange(tx, actor);
      const before = await lockPerson(tx, actor.companyId, userId);
      if (!before) throw new DomainError("not_found");
      if (before.isActive) return { result: toPersonDTO(before), notify: [] };
      await cancelScheduledScrubIn(tx, actor, before);
      const after = await updatePersonRow(tx, actor.companyId, before.id, { isActive: true });
      await recordPersonChange(tx, actor, { type: ADMIN_EVENT_TYPES.userReactivated, before, after });
      const { notify } = await rerouteApprovals(ctx, tx, actor, await listPendingSelfRouted(tx, actor.companyId));
      return { result: toPersonDTO(after), notify };
    }),
  );
}

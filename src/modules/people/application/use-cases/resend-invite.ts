import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import type { ServiceContext } from "@/server/context";
import { commitThenNotify } from "@/modules/notifications";
import { assertUnderInviteLimit, beginAdminChange, inviteEmail, inviterName } from "@/modules/people/application/admin-change";
import { type PersonDTO, toPersonDTO } from "@/modules/people/application/dto";
import { recordPersonChange } from "@/modules/people/application/person-changes";
import { canManagePeople } from "@/modules/people/application/policies";
import { findPerson } from "@/shared/lib/db/members";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

/**
 * Emails an active person a fresh sign-in link, as the invite did. Counts towards the
 * invite rate limit and is audited (`user.invite_resent`).
 *
 * Fails with `forbidden` (not an admin, or the person is deactivated), `not_found`, or
 * `rate_limited`.
 */
export async function resendInvite(ctx: ServiceContext, actor: Actor, userId: string): Promise<ServiceResult<PersonDTO>> {
  if (!canManagePeople(actor)) return err("forbidden");
  return attempt(() =>
    commitThenNotify(ctx, actor.companyId, async (tx) => {
      const company = await beginAdminChange(tx, actor);
      const person = await findPerson(tx, actor.companyId, userId);
      if (!person) throw new DomainError("not_found");
      if (!person.isActive) throw new DomainError("forbidden");
      await assertUnderInviteLimit(tx, actor);
      await recordPersonChange(tx, actor, { type: ADMIN_EVENT_TYPES.userInviteResent, before: null, after: person, afterSnapshot: { email: person.email } });
      return { result: toPersonDTO(person), notify: [inviteEmail(ctx, person, await inviterName(tx, actor), company.name)] };
    }),
  );
}

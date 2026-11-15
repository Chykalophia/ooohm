import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import type { ServiceContext } from "@/server/context";
import { listPendingSelfRouted, rerouteApprovals } from "@/modules/approvals";
import { commitThenNotify } from "@/modules/notifications";
import { assertUnderInviteLimit, beginAdminChange, inviteEmail, inviterName } from "@/modules/people/application/admin-change";
import { type PersonDTO, toPersonDTO } from "@/modules/people/application/dto";
import { recordPersonChange } from "@/modules/people/application/person-changes";
import { assertManagerFor, assertPlacement, type InviteInput, normalizePersonInput } from "@/modules/people/application/person-input";
import { canManagePeople } from "@/modules/people/application/policies";
import { emailInUse } from "@/modules/people/infrastructure/drizzle-people.repository";
import { isUniqueViolation } from "@/shared/lib/db/errors";
import { insertPerson } from "@/shared/lib/db/members";
import { normalizeEmail } from "@/shared/kernel/names";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

/**
 * Invites a person: creates their account in the actor's company and, after commit,
 * emails them a sign-in link. Never goes through Better Auth's sign-up, so access stays
 * invite-only. Every write runs under the company lock, with its audit row and
 * `user.created` event. Inviting an admin re-routes any request an admin had routed to
 * themself for want of another admin (see `rerouteApprovals`).
 *
 * @returns The new person. Fails with `forbidden` (not an admin), `invalid_input`,
 *   `already_exists` (the email has an account, in this company or any other: the
 *   message does not say which), `invalid_manager`, or `rate_limited` (over
 *   `INVITE_LIMIT` invites in `INVITE_WINDOW_MINUTES` minutes).
 */
export async function invitePerson(ctx: ServiceContext, actor: Actor, input: InviteInput): Promise<ServiceResult<PersonDTO>> {
  if (!canManagePeople(actor)) return err("forbidden");
  return attempt(async () => {
    const email = normalizeEmail(input.email);
    const fields = normalizePersonInput(input);
    try {
      return await commitThenNotify(ctx, actor.companyId, async (tx) => {
        const company = await beginAdminChange(tx, actor);
        await assertUnderInviteLimit(tx, actor);
        if (await emailInUse(tx, email)) throw new DomainError("already_exists");
        await assertPlacement(tx, actor.companyId, fields);
        await assertManagerFor(tx, actor.companyId, null, fields.managerId);

        const person = await insertPerson(tx, { id: ctx.ids.next(), companyId: actor.companyId, email, ...fields });
        await recordPersonChange(tx, actor, { type: ADMIN_EVENT_TYPES.userCreated, before: null, after: person });
        const rerouted = person.role === "admin" ? await rerouteApprovals(ctx, tx, actor, await listPendingSelfRouted(tx, actor.companyId)) : null;
        return {
          result: toPersonDTO(person),
          notify: [inviteEmail(ctx, person, await inviterName(tx, actor), company.name), ...(rerouted?.notify ?? [])],
        };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("already_exists");
      throw e;
    }
  });
}

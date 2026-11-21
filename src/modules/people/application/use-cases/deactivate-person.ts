import "server-only";
import type { Transaction } from "@/db/types";
import type { Actor } from "@/shared/kernel/actor";
import { DomainError } from "@/shared/kernel/errors";
import { ADMIN_EVENT_TYPES } from "@/shared/kernel/events";
import type { ServiceContext } from "@/server/context";
import { listPendingAssignedTo, rerouteApprovals } from "@/modules/approvals";
import { countLiveApiKeys, countLiveEndpoints } from "@/modules/integrations";
import { commitThenNotify } from "@/modules/notifications";
import { beginAdminChange } from "@/modules/people/application/admin-change";
import { type PersonDTO, toPersonDTO } from "@/modules/people/application/dto";
import { personSnapshot, recordPersonChange } from "@/modules/people/application/person-changes";
import { canManagePeople } from "@/modules/people/application/policies";
import { assertKeepsAnActiveAdmin, assertNotSelfDeactivation } from "@/modules/people/domain/people";
import { deleteSessionsOf } from "@/modules/people/infrastructure/drizzle-people.repository";
import { revokeFeedsOnDeactivation } from "@/modules/calendar";
import { listActiveAdmins, lockPerson, type PersonRow, updatePerson as updatePersonRow } from "@/shared/lib/db/members";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

/** What a deactivation did besides flipping the flag. */
export interface DeactivationResult {
  person: PersonDTO;
  sessionsRevoked: number;
  feedsRevoked: number;
  /** Pending requests that were waiting on this person and now wait on someone else. */
  requestsReassigned: number;
  /**
   * Unrevoked API keys and undeleted webhook endpoints this person created. They belong
   * to the company and keep working; they are reported because the person saw each key
   * and signing secret in full, so an admin may want to revoke or rotate them.
   */
  liveApiKeysCreated: number;
  liveWebhookEndpointsCreated: number;
}

/**
 * Deactivates a person: they can no longer sign in (every session is deleted, and the
 * session hook refuses new ones), their calendar feed links are turned off, and they
 * drop out of approvals, calendars and emails. Their own requests stay as they are.
 *
 * Pending requests they were assigned to approve move to whoever the approval rule
 * now picks for each requester (their active manager, else their department's active
 * manager, else the longest-standing other active admin; never self-approval), each with
 * a `leave.reassigned` event and a review email to the new approver after commit.
 *
 * API keys and webhook endpoints they created stay (they belong to the company); the
 * result counts the live ones so the admin can review them. Doing it again to someone
 * already inactive changes and records nothing.
 *
 * Fails with `forbidden`, `not_found`, `self_change_not_allowed` (the actor themself), or
 * `last_admin`.
 */
export async function deactivatePerson(ctx: ServiceContext, actor: Actor, userId: string): Promise<ServiceResult<DeactivationResult>> {
  if (!canManagePeople(actor)) return err("forbidden");
  return attempt(() => {
    assertNotSelfDeactivation(actor.id, userId);
    return commitThenNotify(ctx, actor.companyId, async (tx) => {
      await beginAdminChange(tx, actor);
      const before = await lockPerson(tx, actor.companyId, userId);
      if (!before) throw new DomainError("not_found");
      if (!before.isActive) {
        return { result: { person: toPersonDTO(before), sessionsRevoked: 0, feedsRevoked: 0, requestsReassigned: 0, ...(await credentialsOf(tx, actor.companyId, before.id)) }, notify: [] };
      }
      const admins = await listActiveAdmins(tx, actor.companyId);
      assertKeepsAnActiveAdmin({ personId: before.id, before, after: { role: before.role, isActive: false } }, admins.map((a) => a.id));
      const { after, sessionsRevoked, feedsRevoked } = await signOut(ctx, tx, actor, before);
      const { reassigned, notify } = await rerouteApprovals(ctx, tx, actor, await listPendingAssignedTo(tx, actor.companyId, before.id));
      await recordPersonChange(tx, actor, {
        type: ADMIN_EVENT_TYPES.userDeactivated,
        before,
        after,
        afterSnapshot: { ...personSnapshot(after), sessionsRevoked, feedsRevoked, requestsReassigned: reassigned },
      });
      const result = { person: toPersonDTO(after), sessionsRevoked, feedsRevoked, requestsReassigned: reassigned, ...(await credentialsOf(tx, actor.companyId, before.id)) };
      return { result, notify };
    });
  });
}

/** Flips the flag, deletes every session and turns off their calendar links. */
async function signOut(ctx: ServiceContext, tx: Transaction, actor: Actor, before: PersonRow) {
  const after = await updatePersonRow(tx, actor.companyId, before.id, { isActive: false });
  const sessionsRevoked = await deleteSessionsOf(tx, before.id);
  const feedsRevoked = await revokeFeedsOnDeactivation(tx, actor.companyId, before.id, actor.source, ctx.now());
  return { after, sessionsRevoked, feedsRevoked };
}

/** The live API keys and webhook endpoints the person created. */
async function credentialsOf(tx: Transaction, companyId: string, userId: string) {
  return {
    liveApiKeysCreated: await countLiveApiKeys(tx, companyId, userId),
    liveWebhookEndpointsCreated: await countLiveEndpoints(tx, companyId, userId),
  };
}

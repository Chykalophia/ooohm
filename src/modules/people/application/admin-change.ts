import "server-only";
/**
 * What every admin change to people starts with: the company lock (so the rules that span
 * several people hold under concurrency: the last-admin guard, the manager-cycle rule and
 * the invite rate limit) and the check that the actor is still an active admin; and the
 * invite email the invite, the resend and the CSV import send after commit.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import type { ServiceContext } from "@/server/context";
import { countRecentActions } from "@/modules/audit";
import type { Notification } from "@/modules/notifications";
import { type CompanyDTO, lockCompanyForChange } from "@/modules/organisation";
import { assertActiveAdmin } from "@/shared/lib/admin-access";
import { findPerson, type PersonRow } from "@/shared/lib/db/members";
import { personLabel } from "@/shared/kernel/person-label";

/** Most invites (new or resent) one admin may send per {@link INVITE_WINDOW_MINUTES}. */
export const INVITE_LIMIT = 30;
export const INVITE_WINDOW_MINUTES = 60;

/** Locks the company and checks the actor is still an active admin of it. @throws DomainError `no_company`, `forbidden`. */
export async function beginAdminChange(tx: Transaction, actor: Actor): Promise<CompanyDTO> {
  const company = await lockCompanyForChange(tx, actor.companyId);
  if (!company) throw new DomainError("no_company");
  await assertActiveAdmin(tx, actor);
  return company;
}

/**
 * Counts the actor's invites (new and resent) in the window. Runs under the company
 * lock, so parallel invites by one admin cannot all slip under the cap.
 *
 * @throws DomainError `rate_limited`.
 */
export async function assertUnderInviteLimit(tx: Transaction, actor: Actor): Promise<void> {
  const sent = await countRecentActions(
    tx,
    // People added by a CSV import have their own limit (`importPeople`).
    { companyId: actor.companyId, actorId: actor.id, actions: [ADMIN_EVENT_TYPES.userCreated, ADMIN_EVENT_TYPES.userInviteResent], via: null },
    INVITE_WINDOW_MINUTES,
  );
  if (sent >= INVITE_LIMIT) throw new DomainError("rate_limited");
}

/**
 * The invite email for `person`. The sign-in link is issued at send time, after commit,
 * because the account it signs into must exist first. A failure (link or SMTP) is
 * logged as `invite_email_failed` with the person's id, never their address.
 */
export function inviteEmail(ctx: ServiceContext, person: PersonRow, inviterName: string, companyName: string): Notification {
  return {
    type: "invite",
    to: person.email,
    data: { userId: person.id, recipientName: person.name, inviterName, companyName, signInUrl: `${ctx.appUrl}/sign-in` },
  };
}

/** How an invite names the admin who sent it. */
export async function inviterName(tx: Transaction, actor: Actor): Promise<string> {
  const me = await findPerson(tx, actor.companyId, actor.id);
  return me ? personLabel(me) : "";
}

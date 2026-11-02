import type { Executor, Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { DomainError } from "@/domain/errors";
import type { AdminEventType, IntegrationEventType } from "@/domain/events";
import { recordChange } from "@/server/repositories/change-log";
import { findMember } from "@/server/repositories/users";

/**
 * The check every admin write runs inside its transaction: the actor is an admin by
 * the session ({@link assertCanAdminister}) and still an active admin of their
 * company in the database, so a demotion or deactivation committed a moment ago
 * already stops them. A plain read, not a lock: two admins editing each other must not
 * deadlock on each other's rows.
 *
 * @throws DomainError `forbidden`.
 */
export async function assertActiveAdmin(ex: Executor, actor: Actor): Promise<void> {
  assertCanAdminister(actor);
  const me = await findMember(ex, actor.companyId, actor.id);
  if (!me?.isActive || me.role !== "admin") throw new DomainError("forbidden");
}

/**
 * Writes the audit row and outbox event for one admin change, inside `tx`, attributed to
 * the admin as they are acting (`actor.source`). The audit `action` and the event `type`
 * are the same name (`user.created`, `holiday.deleted`).
 *
 * @param change.payload The event payload documented for `type` in `@/domain/events`,
 *   without `actorId` and `actor`, which `recordChange` adds. Never a token, session or
 *   sign-in link.
 */
export async function recordAdminChange(
  tx: Transaction,
  actor: Actor,
  change: {
    type: AdminEventType | IntegrationEventType;
    entityType: string;
    entityId: string;
    subjectUserId?: string | null;
    before: unknown;
    after: unknown;
    payload: object;
  },
): Promise<void> {
  await recordChange(tx, {
    source: actor.source,
    audit: {
      companyId: actor.companyId,
      action: change.type,
      entityType: change.entityType,
      entityId: change.entityId,
      subjectUserId: change.subjectUserId ?? null,
      before: change.before,
      after: change.after,
    },
    event: { companyId: actor.companyId, type: change.type, payload: change.payload },
  });
}

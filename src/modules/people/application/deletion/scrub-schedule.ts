import "server-only";
/** Scheduling a full scrub for after the grace period, and undoing one, each audited. */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { ADMIN_EVENT_TYPES, type Unattributed, type UserDeletionScheduleEventPayload } from "@/domain/events";
import { hasScheduledScrub } from "@/modules/people/domain/deletion-lifecycle";
import { clearScrubSchedule, scheduleScrub } from "@/modules/people/infrastructure/drizzle-person-deletion.repository";
import { recordAdminChange } from "@/shared/lib/admin-access";
import type { PersonRow } from "@/shared/lib/db/members";

/** Schedules the person's full scrub for `scheduledFor` and records it (`user.deletion_scheduled`). */
export async function scheduleScrubIn(tx: Transaction, actor: Actor, person: PersonRow, scheduledFor: Date): Promise<void> {
  await scheduleScrub(tx, actor.companyId, person.id, { at: scheduledFor, requestedBy: actor.id });
  const payload: Unattributed<UserDeletionScheduleEventPayload> = { userId: person.id, scheduledFor: scheduledFor.toISOString() };
  await recordAdminChange(tx, actor, {
    type: ADMIN_EVENT_TYPES.userDeletionScheduled,
    entityType: "user",
    entityId: person.id,
    subjectUserId: person.id,
    before: null,
    after: { scheduledFor: scheduledFor.toISOString() },
    payload,
  });
}

/**
 * Clears a scheduled scrub inside `tx` and records it (`user.deletion_cancelled`). The
 * caller holds the company and member locks. @returns Whether one was scheduled.
 */
export async function cancelScheduledScrubIn(tx: Transaction, actor: Actor, person: PersonRow): Promise<boolean> {
  if (!hasScheduledScrub(person) || !person.scrubScheduledAt) return false;
  if (!(await clearScrubSchedule(tx, actor.companyId, person.id))) return false;
  const scheduledFor = person.scrubScheduledAt.toISOString();
  const payload: Unattributed<UserDeletionScheduleEventPayload> = { userId: person.id, scheduledFor };
  await recordAdminChange(tx, actor, {
    type: ADMIN_EVENT_TYPES.userDeletionCancelled,
    entityType: "user",
    entityId: person.id,
    subjectUserId: person.id,
    before: { scheduledFor },
    after: null,
    payload,
  });
  return true;
}

import "server-only";
/**
 * How a change to a person is recorded: the audited snapshot, the `user.*` event payload,
 * and the one call that writes both (`recordAdminChange`: audit row and outbox event in
 * the caller's transaction).
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/shared/kernel/actor";
import type { AdminEventType, Unattributed, UserEventPayload } from "@/shared/kernel/events";
import { recordAdminChange } from "@/shared/lib/admin-access";
import type { PersonRow } from "@/shared/lib/db/members";

/** The audited view of a person. */
export function personSnapshot(p: PersonRow) {
  return {
    name: p.name,
    email: p.email,
    role: p.role,
    departmentId: p.departmentId,
    levelId: p.levelId,
    managerId: p.managerId,
    canSelfApprove: p.canSelfApprove,
    isActive: p.isActive,
  };
}

/** The `user.*` event payload for a person, before attribution. */
export function personPayload(p: PersonRow): Unattributed<UserEventPayload> {
  return {
    userId: p.id,
    email: p.email,
    name: p.name,
    role: p.role,
    departmentId: p.departmentId,
    levelId: p.levelId,
    managerId: p.managerId,
    canSelfApprove: p.canSelfApprove,
    isActive: p.isActive,
  };
}

/**
 * Records a change to `after` (an audit row about them and a `user.*` event), attributed
 * to `actor`. `before` is the snapshot before it (`null` for someone new), and `afterSnapshot`
 * replaces the audited view of `after` when the change records more (or less) than it.
 */
export async function recordPersonChange(
  tx: Transaction,
  actor: Actor,
  change: { type: AdminEventType; before: PersonRow | null; after: PersonRow; afterSnapshot?: object },
): Promise<void> {
  await recordAdminChange(tx, actor, {
    type: change.type,
    entityType: "user",
    entityId: change.after.id,
    subjectUserId: change.after.id,
    before: change.before ? personSnapshot(change.before) : null,
    after: change.afterSnapshot ?? personSnapshot(change.after),
    payload: personPayload(change.after),
  });
}

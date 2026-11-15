import "server-only";
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { ADMIN_EVENT_TYPES } from "@/domain/events";
import { recordPersonChange } from "@/modules/people/application/person-changes";
import type { PersonRow } from "@/shared/lib/db/members";

/**
 * Records a person created outside the people screens (the first install's admin) the
 * way an invite does: a `user.created` audit row and event in the caller's transaction,
 * attributed to `actor`.
 */
export async function recordPersonCreated(tx: Transaction, actor: Actor, person: PersonRow): Promise<void> {
  await recordPersonChange(tx, actor, { type: ADMIN_EVENT_TYPES.userCreated, before: null, after: person });
}

import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import type { ServiceContext } from "@/server/context";
import { beginAdminChange } from "@/modules/people/application/admin-change";
import { loadDeletionFacts } from "@/modules/people/application/deletion/deletion-facts";
import { type DeletionCountsDone, executeDeletion } from "@/modules/people/application/deletion/execute-deletion";
import { scheduleScrubIn } from "@/modules/people/application/deletion/scrub-schedule";
import { canDeletePeople } from "@/modules/people/application/policies";
import { deletionStep } from "@/modules/people/domain/deletion-lifecycle";
import { assertConfirmed, assertDeletable, type DeletionMode, isDeletionMode } from "@/modules/people/domain/person-deletion";
import { lockPerson } from "@/shared/lib/db/members";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { inTransaction } from "@/shared/lib/unit-of-work";

export type DeletionOutcome =
  | { outcome: "deleted"; userId: string; mode: DeletionMode; tombstoneName: string; counts: DeletionCountsDone }
  | {
      outcome: "scheduled";
      userId: string;
      scheduledFor: Date;
      /** Whether it was scheduled before this call, which then changed nothing. */
      alreadyScheduled: boolean;
    };

/**
 * Deletes a deactivated person, or, for a full scrub with the company's grace option on,
 * schedules it (`user.deletion_scheduled`; asking again while scheduled changes nothing).
 * Choosing to keep records runs at once, even when a scrub was scheduled. Runs in one
 * transaction under the company lock and the person's member lock.
 *
 * @param input.mode `scrubbed` or `records_kept`.
 * @param input.confirmName The person's full name, as the admin typed it.
 * @returns Fails with `forbidden`, `not_found` (another company's id, or already
 *   deleted), `invalid_input` (unknown mode), `confirmation_mismatch`, or
 *   `deletion_blocked` with its blockers as `details`: still active, manages people, has
 *   pending requests to decide, or is the last admin.
 */
export async function deletePerson(
  ctx: ServiceContext,
  actor: Actor,
  userId: string,
  input: { mode: string; confirmName: string },
): Promise<ServiceResult<DeletionOutcome>> {
  if (!canDeletePeople(actor)) return err("forbidden");
  const mode = input.mode;
  if (!isDeletionMode(mode)) return err("invalid_input", "Unknown delete mode.");
  return attempt(() =>
    inTransaction(ctx, async (tx): Promise<DeletionOutcome> => {
      const company = await beginAdminChange(tx, actor);
      const person = await lockPerson(tx, actor.companyId, userId);
      if (!person) throw new DomainError("not_found");
      assertConfirmed(input.confirmName, person);
      assertDeletable(await loadDeletionFacts(tx, actor.companyId, person));
      const now = ctx.now();
      const step = deletionStep({ mode, deletionGrace: company.deletionGrace, scrubScheduledAt: person.scrubScheduledAt, now });
      if (step.kind === "already_scheduled") return { outcome: "scheduled", userId: person.id, scheduledFor: step.scheduledFor, alreadyScheduled: true };
      if (step.kind === "schedule") {
        await scheduleScrubIn(tx, actor, person, step.scheduledFor);
        return { outcome: "scheduled", userId: person.id, scheduledFor: step.scheduledFor, alreadyScheduled: false };
      }
      const done = await executeDeletion(tx, { companyId: actor.companyId, person, mode, source: actor.source, now });
      return { outcome: "deleted", userId: person.id, mode, ...done };
    }),
  );
}

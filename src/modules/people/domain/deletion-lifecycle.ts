/**
 * The life of a delete: an admin asks for one, and it either runs at once or, for a full
 * scrub with the company's grace option on, is scheduled (`DELETION_GRACE_DAYS`). While
 * it waits it can be undone (cancelling it, or reactivating the person); once its date
 * passes, the daily job carries it out unless a rule now refuses it. Pure; the use cases
 * read the facts under the company and member locks and act on the step these return.
 */
import type { DeletionMode } from "@/domain/events";
import { scrubDueAt } from "./person-deletion";

/** What a delete request does to a person who passed the delete rules. */
export type DeletionStep =
  /** Run it now: keeping records never waits, nor does a scrub without the grace option. */
  | { kind: "delete_now"; mode: DeletionMode }
  /** Start the grace period: the scrub runs on `scheduledFor`. */
  | { kind: "schedule"; scheduledFor: Date }
  /** A scrub is already waiting: asking again changes nothing. */
  | { kind: "already_scheduled"; scheduledFor: Date };

/**
 * The step a delete request takes. Keeping records runs at once even when a scrub was
 * scheduled (it replaces it).
 */
export function deletionStep(input: { mode: DeletionMode; deletionGrace: boolean; scrubScheduledAt: Date | null; now: Date }): DeletionStep {
  if (input.mode !== "scrubbed" || !input.deletionGrace) return { kind: "delete_now", mode: input.mode };
  if (input.scrubScheduledAt) return { kind: "already_scheduled", scheduledFor: input.scrubScheduledAt };
  return { kind: "schedule", scheduledFor: scrubDueAt(input.now) };
}

/** Whether a scheduled scrub's grace period has ended at `now` (`false` when none is scheduled). */
export function isScrubDue(scrubScheduledAt: Date | null, now: Date): boolean {
  return scrubScheduledAt !== null && scrubScheduledAt.getTime() <= now.getTime();
}

/**
 * Whether a due scrub is held back: its date has passed but a rule now refuses it, so
 * the daily job leaves it waiting (and the person's page says why).
 */
export function isScrubWaiting(scrubScheduledAt: Date | null, now: Date, blocked: boolean): boolean {
  return isScrubDue(scrubScheduledAt, now) && blocked;
}

/** Whether undoing (a cancel, or reactivating the person) has a scheduled scrub to clear. */
export function hasScheduledScrub(person: { scrubScheduledAt: Date | null }): boolean {
  return person.scrubScheduledAt !== null;
}

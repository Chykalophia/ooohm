import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import type { ServiceContext } from "@/server/context";
import { findCompany } from "@/modules/organisation";
import { loadDeletionFacts } from "@/modules/people/application/deletion/deletion-facts";
import { type PersonDTO, toPersonDTO } from "@/modules/people/application/dto";
import { canDeletePeople } from "@/modules/people/application/policies";
import { isScrubWaiting } from "@/modules/people/domain/deletion-lifecycle";
import {
  type DeletionBlockers,
  type DeletionCounts,
  type DeletionMode,
  deletionBlockers,
  describeDeletion,
  isBlocked,
} from "@/modules/people/domain/person-deletion";
import { countDeletionFacts } from "@/modules/people/infrastructure/drizzle-person-deletion.repository";
import { findPerson } from "@/shared/lib/db/members";
import { confirmationTarget } from "@/shared/kernel/person-label";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";

/** What the delete confirmation shows: what blocks it, or what each mode would remove. */
export interface DeletionPreview {
  person: PersonDTO;
  /** What the admin types to confirm: the name as shown (the email when it is blank). */
  confirmName: string;
  blockers: DeletionBlockers;
  blocked: boolean;
  counts: DeletionCounts;
  describe: Record<DeletionMode, { removes: string[]; keeps: string[] }>;
  /** The company's grace option: a full scrub waits `DELETION_GRACE_DAYS`, with undo. */
  deletionGrace: boolean;
  /**
   * A scheduled scrub whose date has passed but which the rules now refuse: the daily
   * job leaves it waiting until `blockers` are sorted out.
   */
  scrubWaiting: boolean;
}

/**
 * Everything the delete dialog needs about one person: what blocks deleting them (still
 * active, people who report to them, pending requests waiting on them, the last admin),
 * and what each mode would remove, counted from the database.
 *
 * Fails with `forbidden` (not an admin), `not_found` (another company's id, or someone
 * already deleted), or `no_company`.
 */
export async function getDeletionPreview(ctx: ServiceContext, actor: Actor, userId: string): Promise<ServiceResult<DeletionPreview>> {
  if (!canDeletePeople(actor)) return err("forbidden");
  return attempt(async () => {
    const [person, company] = await Promise.all([findPerson(ctx.db, actor.companyId, userId), findCompany(ctx.db, actor.companyId)]);
    if (!person) throw new DomainError("not_found");
    if (!company) throw new DomainError("no_company");
    const [facts, counts] = await Promise.all([loadDeletionFacts(ctx.db, actor.companyId, person), countDeletionFacts(ctx.db, actor.companyId, person.id)]);
    const blockers = deletionBlockers(facts);
    return {
      person: toPersonDTO(person),
      confirmName: confirmationTarget(person),
      blockers,
      blocked: isBlocked(blockers),
      counts,
      describe: { scrubbed: describeDeletion("scrubbed", counts), records_kept: describeDeletion("records_kept", counts) },
      deletionGrace: company.deletionGrace,
      scrubWaiting: isScrubWaiting(person.scrubScheduledAt, ctx.now(), isBlocked(blockers)),
    };
  });
}

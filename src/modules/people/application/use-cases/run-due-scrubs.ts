import "server-only";
import { bySystem, CHANGE_PROCESSES } from "@/shared/kernel/change-source";
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { loadDeletionFacts } from "@/modules/people/application/deletion/deletion-facts";
import { executeDeletion } from "@/modules/people/application/deletion/execute-deletion";
import { isScrubDue } from "@/modules/people/domain/deletion-lifecycle";
import { deletionBlockers, isBlocked } from "@/modules/people/domain/person-deletion";
import { type DueScrubCursor, findScrubRequest, listDueScrubs } from "@/modules/people/infrastructure/drizzle-person-deletion.repository";
import { lockCompany } from "@/shared/lib/db/company-lock";
import { lockPerson } from "@/shared/lib/db/members";
import { inTransaction } from "@/shared/lib/unit-of-work";

/** Most scheduled scrubs one daily run carries out; the rest wait for the next run. */
export const SCRUBS_PER_RUN = 50;

/** Most due scrubs one run looks at, carried out or not, so blocked ones cannot make a run endless. */
export const SCRUB_CHECKS_PER_RUN = 500;

/** What one run of the scheduled-scrub job did. */
export interface ScrubRunResult {
  scrubbed: number;
  /**
   * Due scrubs a rule now refuses (say, someone reports to them again): left scheduled,
   * retried on the next run, and shown on the person's page with what blocks them.
   */
  blocked: number;
}

/** One due scrub, in its own transaction. */
export type DueScrubOutcome = "scrubbed" | "blocked" | "gone" | "failed";

/** A due scrub as the job lists it, oldest first. */
export interface DueScrub {
  id: string;
  companyId: string | null;
  scrubScheduledAt: Date | null;
}

/** What the sweep needs: the next due scrubs after a cursor, and a way to run one. */
export interface DueScrubSweep {
  listDue(limit: number, cursor?: DueScrubCursor): Promise<DueScrub[]>;
  runOne(id: string, companyId: string): Promise<DueScrubOutcome>;
}

/**
 * The daily job's step: carries out every full scrub whose grace period has ended (at most
 * `limit`), each in its own transaction under the company lock and the person's member
 * lock, attributed to the system (`scheduled_scrub`) on behalf of the admin who asked.
 * The rules are checked again first; a scrub they now refuse is logged
 * (`scheduled_scrub_blocked`), left scheduled and passed over, so it never holds up the
 * ones due after it. A failure of one is logged and does not stop the others. Never throws
 * for one scrub's failure.
 */
export async function runDueScrubs(ctx: ServiceContext, options: { limit?: number } = {}): Promise<ScrubRunResult> {
  const now = ctx.now();
  return sweepDueScrubs(
    {
      listDue: (limit, cursor) => listDueScrubs(ctx.db, now, limit, cursor),
      runOne: (id, companyId) => runOneDueScrub(ctx, id, companyId, now),
    },
    options.limit ?? SCRUBS_PER_RUN,
  );
}

/** Pages through the due scrubs, running each, until `limit` are done or {@link SCRUB_CHECKS_PER_RUN} were looked at. */
export async function sweepDueScrubs(sweep: DueScrubSweep, limit: number): Promise<ScrubRunResult> {
  const result: ScrubRunResult = { scrubbed: 0, blocked: 0 };
  let checked = 0;
  let cursor: DueScrubCursor | undefined;
  while (result.scrubbed < limit && checked < SCRUB_CHECKS_PER_RUN) {
    const due = await sweep.listDue(Math.min(limit, SCRUB_CHECKS_PER_RUN - checked), cursor);
    if (due.length === 0) break;
    const last = due.at(-1)!;
    cursor = { at: last.scrubScheduledAt!, id: last.id };
    checked += due.length;
    for (const { id, companyId } of due) {
      if (result.scrubbed >= limit) break;
      if (!companyId) continue;
      const outcome = await sweep.runOne(id, companyId);
      if (outcome === "scrubbed") result.scrubbed++;
      if (outcome === "blocked") result.blocked++;
    }
  }
  return result;
}

/** One due scrub, in its own transaction. Never throws: a failure is logged. */
async function runOneDueScrub(ctx: ServiceContext, id: string, companyId: string, now: Date): Promise<DueScrubOutcome> {
  try {
    const outcome = await inTransaction(ctx, async (tx): Promise<DueScrubOutcome> => {
      if (!(await lockCompany(tx, companyId))) return "gone";
      const person = await lockPerson(tx, companyId, id);
      if (!person || !isScrubDue(person.scrubScheduledAt, now)) return "gone";
      if (isBlocked(deletionBlockers(await loadDeletionFacts(tx, companyId, person)))) return "blocked";
      const request = await findScrubRequest(tx, companyId, person.id);
      const source = bySystem(CHANGE_PROCESSES.scheduledScrub, request?.scrubRequestedBy ?? undefined);
      await executeDeletion(tx, { companyId, person, mode: "scrubbed", source, now });
      return "scrubbed";
    });
    if (outcome === "blocked") log.warn({ userId: id, companyId }, "scheduled_scrub_blocked");
    return outcome;
  } catch (err) {
    log.error({ userId: id, companyId, err }, "scheduled_scrub_failed");
    return "failed";
  }
}

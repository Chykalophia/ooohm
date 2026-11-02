import { and, eq, lte } from "drizzle-orm";
import { scheduledJobs } from "@/db/schema";
import type { Executor } from "@/db/types";

/**
 * Claims job `name` if it is due at `now`: creates its row (due at once) the first
 * time, then moves `next_run_at` to `leaseUntil` with a compare-and-set. Of several
 * workers claiming at once exactly one gets `true`; the row lock serialises them and the
 * loser re-reads a `next_run_at` in the future. The lease doubles as the retry time if
 * the run crashes without finishing.
 */
export async function claimJob(ex: Executor, name: string, now: Date, leaseUntil: Date): Promise<boolean> {
  await ex.insert(scheduledJobs).values({ name, nextRunAt: now }).onConflictDoNothing({ target: scheduledJobs.name });
  const rows = await ex
    .update(scheduledJobs)
    .set({ nextRunAt: leaseUntil, lastStartedAt: now })
    .where(and(eq(scheduledJobs.name, name), lte(scheduledJobs.nextRunAt, now)))
    .returning({ name: scheduledJobs.name });
  return rows.length === 1;
}

/** Records how a claimed run ended and when the job is next due. */
export async function finishJob(ex: Executor, name: string, input: { at: Date; nextRunAt: Date; error: string | null }): Promise<void> {
  await ex
    .update(scheduledJobs)
    .set({ lastFinishedAt: input.at, nextRunAt: input.nextRunAt, lastError: input.error })
    .where(eq(scheduledJobs.name, name));
}

export async function findJob(ex: Executor, name: string) {
  const [row] = await ex.select().from(scheduledJobs).where(eq(scheduledJobs.name, name));
  return row;
}

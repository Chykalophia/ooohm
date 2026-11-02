/**
 * Daily jobs the outbox worker runs, so a host cron is optional: the year rollover
 * and integration retention.
 *
 * Each job is claimed with a compare-and-set on its `scheduled_jobs` row before it runs,
 * so however many workers there are, exactly one runs it per day, and a restart does not
 * run it again early. A run that fails is retried an hour later; one that crashes leaves
 * its lease to run out (also an hour). Both jobs are idempotent, so the rare overlap after
 * an expired lease is harmless.
 */
import { log } from "@/lib/log";
import type { ServiceContext } from "@/server/context";
import { claimJob, finishJob } from "@/server/repositories/scheduled-jobs";
import { pruneIntegrationData } from "./retention";
import { runYearRollover } from "./rollover";

const HOUR = 3_600_000;
export const JOB_INTERVAL_MS = 24 * HOUR;
/** How long a claim lasts, and how soon a failed run is tried again. */
export const JOB_RETRY_MS = HOUR;

export const DAILY_JOBS: Readonly<Record<string, (ctx: ServiceContext) => Promise<Record<string, number>>>> = {
  year_rollover: async (ctx) => ({ ...(await runYearRollover(ctx)) }),
  integration_retention: async (ctx) => ({ ...(await pruneIntegrationData(ctx)) }),
};

/**
 * Runs every daily job that is due and that this worker wins the claim for. Never
 * throws: a failure is logged (`scheduled_job_failed`) and recorded on the job's row.
 *
 * @returns The names of the jobs this call ran (successfully or not).
 */
export async function runDueJobs(ctx: ServiceContext, jobs = DAILY_JOBS): Promise<string[]> {
  const ran: string[] = [];
  for (const [name, run] of Object.entries(jobs)) {
    const now = ctx.now();
    let claimed: boolean;
    try {
      claimed = await claimJob(ctx.db, name, now, new Date(now.getTime() + JOB_RETRY_MS));
    } catch (err) {
      log.error({ job: name, err }, "scheduled_job_claim_failed");
      continue;
    }
    if (!claimed) continue;
    ran.push(name);
    try {
      const summary = await run(ctx);
      const at = ctx.now();
      await finishJob(ctx.db, name, { at, nextRunAt: new Date(now.getTime() + JOB_INTERVAL_MS), error: null });
      log.info({ job: name, ...summary }, "scheduled_job_done");
    } catch (err) {
      log.error({ job: name, err }, "scheduled_job_failed");
      // Name and code only: a query error's message carries its bound parameters.
      const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
      const message = err instanceof Error ? `${err.name}${typeof code === "string" ? ` (${code})` : ""}`.slice(0, 100) : "failed";
      await finishJob(ctx.db, name, { at: ctx.now(), nextRunAt: new Date(ctx.now().getTime() + JOB_RETRY_MS), error: message }).catch((e) =>
        log.error({ job: name, err: e }, "scheduled_job_record_failed"),
      );
    }
  }
  return ran;
}

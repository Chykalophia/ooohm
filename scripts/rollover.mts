/**
 * Year rollover job: `pnpm job:rollover [year]`.
 *
 * Closes `year` (default: the previous year in each company's time zone): applies
 * carryover into the next year and creates missing allowance rows (current-year rows
 * from leave type defaults; next-year rows copied forward for types without one).
 * Idempotent, so it is safe to run on every start (the compose `migrate` service
 * does); the worker or the `/api/cron/tick` route runs it daily. Needs only the
 * database settings.
 */
import { resolveDatabaseConfig } from "../src/db/config";
import { openDatabase } from "../src/db/connect";
import { nonEmptyEnv } from "../src/lib/integration-env";
import { runYearRollover } from "../src/server/services/rollover";
import { scriptContext } from "./script-context.mts";

const config = resolveDatabaseConfig(nonEmptyEnv(process.env));

const arg = process.argv[2];
if (arg !== undefined && !/^\d{4}$/.test(arg)) {
  console.error(`Usage: pnpm job:rollover [year], e.g. pnpm job:rollover 2026 (got "${arg}")`);
  process.exit(2);
}

const handle = await openDatabase(config, { purpose: "pnpm job:rollover", max: 1 });
const ctx = scriptContext(handle.db, "rollover job");

try {
  const result = await runYearRollover(ctx, arg === undefined ? undefined : Number(arg));
  console.log(
    `Rollover done: ${result.companies} companies, ${result.members} people, ` +
      `${result.carried} carryovers set, ${result.created} allowances created.`,
  );
} catch (err) {
  console.error(`Rollover failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await handle.close();
}

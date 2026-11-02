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
import { STRICT_TARGET_POLICY } from "../src/domain/webhook-target";
import { unavailableSecretBox } from "../src/lib/integration-crypto";
import { nonEmptyEnv } from "../src/lib/integration-env";
import type { ServiceContext } from "../src/server/context";
import { createAdapterRegistry } from "../src/server/integrations/adapter";
import { runYearRollover } from "../src/server/services/rollover";

const config = resolveDatabaseConfig(nonEmptyEnv(process.env));

const arg = process.argv[2];
if (arg !== undefined && !/^\d{4}$/.test(arg)) {
  console.error(`Usage: pnpm job:rollover [year], e.g. pnpm job:rollover 2026 (got "${arg}")`);
  process.exit(2);
}

const handle = await openDatabase(config, { purpose: "pnpm job:rollover", max: 1 });
const ctx: ServiceContext = {
  db: handle.db,
  // The rollover sends no email; failing loudly beats silently dropping one.
  mailer: async () => {
    throw new Error("The rollover job does not send email.");
  },
  defer: (task) => void task(),
  appUrl: "",
  now: () => new Date(),
  issueSignInLink: async () => {
    throw new Error("The rollover job does not sign anyone in.");
  },
  secrets: unavailableSecretBox("The rollover job holds no webhook encryption key."),
  webhookTargets: STRICT_TARGET_POLICY,
  adapters: createAdapterRegistry(),
};

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

/**
 * Applies pending migrations from ./drizzle. Safe to run on every start.
 *
 *   pnpm db:migrate                  any Postgres (DATABASE_URL_UNPOOLED when set), or embedded
 *   tsx scripts/migrate.mts --if-production
 *                                    the Vercel build step: migrates only when
 *                                    VERCEL_ENV is "production", and does nothing otherwise,
 *                                    so a preview build never touches the database
 */
import { resolveDatabaseConfig } from "../src/db/config";
import { migrateDatabase } from "../src/db/connect";
import { nonEmptyEnv } from "../src/lib/integration-env";

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--if-production");
if (unknown.length > 0) {
  console.error(`Unknown argument: ${unknown.join(" ")}. Usage: migrate.mts [--if-production]`);
  process.exit(2);
}

const env = nonEmptyEnv(process.env);
if (args.includes("--if-production") && env.VERCEL_ENV !== "production") {
  console.log(`Skipping migrations: VERCEL_ENV is "${env.VERCEL_ENV ?? "unset"}", not "production". Only production builds migrate.`);
  process.exit(0);
}

const config = resolveDatabaseConfig(env);
await migrateDatabase(config, { purpose: "pnpm db:migrate" });
console.log(config.kind === "embedded" ? `Migrations applied to the embedded database at ${config.dataDir}.` : "Migrations applied.");

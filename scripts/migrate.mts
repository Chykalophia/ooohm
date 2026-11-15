/**
 * Applies pending migrations from ./drizzle. Safe to run on every start.
 *
 *   pnpm db:migrate                  any Postgres, as the owner (DATABASE_ADMIN_URL, required),
 *                                    then refreshes the app role's grants; or embedded
 *   tsx scripts/migrate.mts --if-production
 *                                    the Vercel build step: migrates only when
 *                                    VERCEL_ENV is "production", and does nothing otherwise,
 *                                    so a preview build never touches the database
 *
 * See docs/deploy.md#database-roles for the two roles.
 */
import { nonEmptyEnv } from "../src/lib/integration-env";
import { adminDatabaseConfig, migrateAsOwner } from "../src/server/admin/db";

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

try {
  adminDatabaseConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const { config, grants, warnings } = await migrateAsOwner({ purpose: "pnpm db:migrate" });
for (const warning of warnings) console.warn(warning);
if (config.kind === "embedded") console.log(`Migrations applied to the embedded database at ${config.dataDir}.`);
else console.log(grants === "applied" ? "Migrations applied; the app role's grants are up to date." : "Migrations applied.");

/**
 * Creates (or repairs) OOOhm's two database roles with deploy/db-roles.sql: the owner,
 * which owns the schema, and the app role, which may change rows but not the schema and
 * may only add to audit_log. Idempotent; the compose `migrate` service runs it before
 * migrating. See docs/deploy.md#database-roles.
 *
 *   pnpm db:roles
 *
 * Connects with DATABASE_SUPERUSER_URL (a superuser, e.g. compose's POSTGRES_USER), else
 * DATABASE_ADMIN_URL (an owner that may create roles, such as Neon's neondb_owner).
 * Optional: OOOHM_DB_OWNER_ROLE (default ooohm_owner; neondb_owner on Neon),
 * OOOHM_DB_APP_ROLE (default ooohm_app), OOOHM_DB_OWNER_PASSWORD, OOOHM_DB_APP_PASSWORD
 * (each sets that role's password when given).
 */
import { DATABASE_ROLES_DOCS } from "../src/db/config";
import { connectPostgres } from "../src/db/connect";
import { adminDatabaseConfig, applyDatabaseRoles, EMBEDDED_SINGLE_HANDLE, roleSetupFromEnv, roleSetupUrl } from "../src/server/admin/db";

let config;
try {
  config = adminDatabaseConfig();
} catch (err) {
  // Without DATABASE_ADMIN_URL a superuser URL is still enough to create the roles.
  if (!roleSetupUrl()) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
if (config?.kind === "embedded") {
  console.log(`${EMBEDDED_SINGLE_HANDLE} Nothing to set up.`);
  process.exit(0);
}

const url = roleSetupUrl();
if (!url) {
  console.error(`Set DATABASE_SUPERUSER_URL (or DATABASE_ADMIN_URL) to run the role setup. See ${DATABASE_ROLES_DOCS}.`);
  process.exit(1);
}
const setup = roleSetupFromEnv();
const handle = connectPostgres({ kind: "postgres", url, migrationUrl: url, prepare: true, max: 1, idleTimeout: undefined });
try {
  await applyDatabaseRoles(handle.client, setup);
  console.log(`Database roles ready: owner "${setup.ownerRole ?? "ooohm_owner"}", app "${setup.appRole ?? "ooohm_app"}".`);
} finally {
  await handle.close();
}

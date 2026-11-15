import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";
import { type DatabaseConfig, databaseUser, DATABASE_ROLES_DOCS, resolveAdminDatabaseConfig } from "@/db/config";
import { connectPostgres, type DatabaseHandle, migrateDatabase, type OpenOptions, openDatabase } from "@/db/connect";
import { nonEmptyEnv } from "@/lib/integration-env";

/**
 * The database owner's connection (ADR-0006): the one place `DATABASE_ADMIN_URL` is read.
 * Migrations, the seed and the TimeOff import open the database here; the app, the cron
 * route and the worker never do (dependency-cruiser allows only this folder and scripts to
 * import it). They connect as the app role through `DATABASE_URL`.
 *
 * On Postgres the owner's URL is required. Embedded PGlite has one built-in user, so it
 * opens the app's single handle, with its directory lock, and says so.
 */

type Env = Record<string, string | undefined>;

/** The owner's database settings, from `source` (default: this process's environment), trimmed. */
export function adminDatabaseConfig(source: Env = process.env): DatabaseConfig {
  return resolveAdminDatabaseConfig(nonEmptyEnv(source));
}

/** The line embedded mode logs where Postgres would connect as the owner. */
export const EMBEDDED_SINGLE_HANDLE = "Embedded PGlite: one built-in user and one handle, so there is no separate owner role.";

/**
 * Opens the database as its owner. `config` is what {@link adminDatabaseConfig} returned,
 * for scripts that resolve it first to fail before doing other work.
 */
export async function openAdminDatabase(options: OpenOptions & { config?: DatabaseConfig; log?: (line: string) => void }): Promise<DatabaseHandle> {
  const config = options.config ?? adminDatabaseConfig();
  if (config.kind === "embedded") (options.log ?? console.log)(EMBEDDED_SINGLE_HANDLE);
  return openDatabase(config, options);
}

/** Where the role setup lives; scripts and tests run from the repository root. */
export const DATABASE_ROLES_SQL = path.resolve(process.cwd(), "deploy", "db-roles.sql");

/** What deploy/db-roles.sql sets up; unset fields take the file's defaults. */
export interface RoleSetup {
  /** Default `ooohm_owner`; in grants-only mode, the connected user. */
  ownerRole?: string | undefined;
  /** Default `ooohm_app`. */
  appRole?: string | undefined;
  ownerPassword?: string | undefined;
  appPassword?: string | undefined;
  /** Refresh the app role's grants only, connected as the owner (after migrations). */
  grantsOnly?: boolean;
}

export const DEFAULT_APP_ROLE = "ooohm_app";

/**
 * The role setup from the environment: `OOOHM_DB_OWNER_ROLE`, `OOOHM_DB_APP_ROLE`,
 * `OOOHM_DB_OWNER_PASSWORD` and `OOOHM_DB_APP_PASSWORD`, all optional.
 */
export function roleSetupFromEnv(source: Env = process.env): RoleSetup {
  const env = nonEmptyEnv(source);
  return {
    ownerRole: env.OOOHM_DB_OWNER_ROLE,
    appRole: env.OOOHM_DB_APP_ROLE,
    ownerPassword: env.OOOHM_DB_OWNER_PASSWORD,
    appPassword: env.OOOHM_DB_APP_PASSWORD,
  };
}

/**
 * Runs deploy/db-roles.sql on `client` in one transaction, with `setup` passed as the
 * file's `ooohm.*` settings (transaction-local, so passwords do not outlive it).
 * Full mode needs a superuser or a role that can create roles and owns the database
 * (Neon's `neondb_owner`); grants-only mode needs the owner.
 */
export async function applyDatabaseRoles(client: postgres.Sql, setup: RoleSetup = {}): Promise<void> {
  const file = readFileSync(DATABASE_ROLES_SQL, "utf8");
  const settings: [string, string | undefined][] = [
    ["ooohm.owner_role", setup.ownerRole],
    ["ooohm.app_role", setup.appRole],
    ["ooohm.owner_password", setup.ownerPassword],
    ["ooohm.app_password", setup.appPassword],
    ["ooohm.grants_only", setup.grantsOnly ? "on" : "off"],
  ];
  await client.begin(async (tx) => {
    for (const [name, value] of settings) await tx`select set_config(${name}, ${value ?? ""}, true)`;
    await tx.unsafe(file);
  });
}

/** What {@link migrateAsOwner} did, and anything about the roles the operator should fix. */
export interface OwnerMigration {
  config: DatabaseConfig;
  /** `applied`: the app role's grants were refreshed; `no_app_role`: it does not exist; `embedded`: no roles. */
  grants: "applied" | "no_app_role" | "embedded";
  warnings: string[];
}

/**
 * Applies pending migrations as the owner, then (on Postgres) refreshes the app role's
 * grants, so a table a migration adds or recreates gets the same rights as the rest and
 * `audit_log` stays read-and-insert only.
 *
 * @throws Error when `DATABASE_ADMIN_URL` is missing on Postgres, or a migration fails.
 */
export async function migrateAsOwner(options: { purpose: string; migrationsFolder?: string | undefined; source?: Env } = { purpose: "migrations" }): Promise<OwnerMigration> {
  const source = options.source ?? process.env;
  const config = adminDatabaseConfig(source);
  await migrateDatabase(config, { purpose: options.purpose, migrationsFolder: options.migrationsFolder });
  if (config.kind === "embedded") return { config, grants: "embedded", warnings: [EMBEDDED_SINGLE_HANDLE] };

  const env = nonEmptyEnv(source);
  const appRole = env.OOOHM_DB_APP_ROLE ?? DEFAULT_APP_ROLE;
  const warnings: string[] = [];
  const appUser = databaseUser(env.DATABASE_URL);
  if (appUser !== undefined && appUser === databaseUser(config.migrationUrl)) {
    warnings.push(`DATABASE_URL and DATABASE_ADMIN_URL both connect as "${appUser}", so the app runs as the owner and can change the schema. Point DATABASE_URL at the app role (${DATABASE_ROLES_DOCS}).`);
  }
  const handle = connectPostgres(config, { max: 1 });
  try {
    const [found] = await handle.client`select 1 as found from pg_roles where rolname = ${appRole}`;
    if (!found) {
      warnings.push(`The app role "${appRole}" does not exist, so its grants were not refreshed. Create it with \`pnpm db:roles\` (${DATABASE_ROLES_DOCS}).`);
      return { config, grants: "no_app_role", warnings };
    }
    await applyDatabaseRoles(handle.client, { appRole, grantsOnly: true });
    return { config, grants: "applied", warnings };
  } finally {
    await handle.close();
  }
}

/**
 * The connection `pnpm db:roles` runs the full setup over: `DATABASE_SUPERUSER_URL` when
 * set (docker-compose's `POSTGRES_USER`), else the owner's `DATABASE_ADMIN_URL` (Neon's
 * `neondb_owner` may create roles).
 */
export function roleSetupUrl(source: Env = process.env): string | undefined {
  const env = nonEmptyEnv(source);
  return env.DATABASE_SUPERUSER_URL ?? env.DATABASE_ADMIN_URL;
}

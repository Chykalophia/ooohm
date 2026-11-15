# ADR-0006: Privileged database access lives in src/server/admin

- **Status:** Accepted (2026-11-14, with the plan in PR #102); implemented in A8 (2026-11-15)
- **Date:** 2026-11-15

## Context

The reference isolates the Supabase service-role client in `src/server/admin/` for webhooks and cron. OOOhm's
equivalent of a service-role key is the database owner's connection string: today the app, the worker, the cron
tick, migrations, the seed and the TimeOff import all use one role (`DATABASE_URL`, plus `DATABASE_URL_UNPOOLED` on
Neon for migrations).

## Decision

- Two roles: `ooohm_owner` (DDL; used by `scripts/migrate.mts`, `seed.mts`, `import-timeoff.mts`) and `ooohm_app`
  (DML only; no `UPDATE`/`DELETE` on `audit_log`; used by the app, the cron route and the worker).
- The owner connection is opened only from `src/server/admin/db.ts`, which dependency-cruiser allows only scripts to
  import. `DATABASE_ADMIN_URL` is **required whenever the database is a Postgres server** (Neon,
  docker-compose, any `postgres://` URL): `scripts/migrate.mts`, `seed.mts` and `import-timeoff.mts` refuse to run
  without it, naming the variable and `docs/deploy.md#database-roles`. It is read and validated only there
  (`src/server/admin/db.ts`, `resolveAdminDatabaseConfig` in `src/db/config.ts`), not in `env.ts`: the app's
  startup does not need the owner's password, so it does not ask for it. `DATABASE_URL_UNPOOLED` is not a fallback.
- The one exception is embedded PGlite (`OOOHM_DB=embedded`): a single process owns the data directory and every
  connection is the same built-in superuser, so there is no second role to use. PGlite installs run with one handle
  and log that they do. This exception is recorded in ADR-0004 and in the A8 exit criteria.
- Never prefix a database URL or secret with `NEXT_PUBLIC_`; the CI bundle grep (F16) checks it.

## Implementation

- `deploy/db-roles.sql` (run by `pnpm db:roles`, and by the compose `migrate` service before migrating) creates the
  roles, hands existing objects to the owner, grants the app role DML on every table but only `SELECT`/`INSERT` on
  `audit_log`, and sets default privileges for later tables, sequences and functions. `pnpm db:migrate` runs it
  again in grants-only mode as the owner after migrating. Role names and passwords are `ooohm.*` settings
  (`OOOHM_DB_OWNER_ROLE`, `OOOHM_DB_APP_ROLE`, `OOOHM_DB_*_PASSWORD`), so Neon keeps `neondb_owner` as the owner.
- Deleting a person must still erase and redact audit rows. It does so through two `SECURITY DEFINER` functions the
  owner owns (`ooohm_erase_audit_about`, `ooohm_redact_audit_snapshots`, migration 0030); a leaked app credential
  can therefore remove the audit rows about one person in a company, but cannot rewrite or delete any other row.
- `tests/integration/db-roles.test.ts` proves the grants on a fresh install and on an upgraded one, and that the
  services (a leave request, a person's deletion) work over an app-role connection.

## Consequences

- A leaked app connection string can't drop tables or rewrite the audit log.
- Neon: one extra role and env var on Vercel; docker-compose: the `migrate` service creates both roles, with two
  new passwords (`OOOHM_DB_OWNER_PASSWORD`, `OOOHM_DB_APP_PASSWORD`).
- On Vercel every variable reaches the functions at run time as well as the build, so the owner's URL is in the
  app's environment there. The split still keeps the app's queries, and a leaked `DATABASE_URL`, off the schema.
- Hosting docs (`docs/hosting.md`, `docs/deploy*.md`) gain one variable, required for Postgres deployments.
- PGlite installs keep one DDL-capable handle; their threat model is one machine, one process.

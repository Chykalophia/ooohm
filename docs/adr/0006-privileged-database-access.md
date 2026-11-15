# ADR-0006: Privileged database access lives in src/server/admin

- **Status:** Proposed
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
  import. `env.ts` gets `DATABASE_ADMIN_URL`, **required whenever the database is a Postgres server** (Neon,
  docker-compose, any `postgres://` URL): startup and `scripts/migrate.mts` refuse to run without it.
- The one exception is embedded PGlite (`OOOHM_DB=embedded`): a single process owns the data directory and every
  connection is the same built-in superuser, so there is no second role to use. PGlite installs run with one handle
  and log that they do. This exception is recorded in ADR-0004 and in the A8 exit criteria.
- Never prefix a database URL or secret with `NEXT_PUBLIC_`; the CI bundle grep (F16) checks it.

## Consequences

- A leaked app connection string can't drop tables or rewrite the audit log.
- Neon: one extra role and env var on Vercel; docker-compose: a migration creates the role.
- Hosting docs (`docs/hosting.md`, `docs/deploy*.md`) gain one variable, required for Postgres deployments.
- PGlite installs keep one DDL-capable handle; their threat model is one machine, one process.

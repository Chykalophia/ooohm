# ADR-0011: Migrations-only schema changes with a drift check

- **Status:** Proposed
- **Date:** 2026-11-15

## Context

The reference's Supabase rule is "migrations only, `supabase db diff` in CI". OOOhm generates SQL with drizzle-kit
from `src/db/schema.ts` and commits it in `drizzle/`; Vercel's build runs `scripts/migrate.mts`. Nothing checks that
the committed migrations match the schema. There is no business logic in the database (no `plpgsql` functions or
triggers), only constraints.

## Decision

- CI runs `drizzle-kit generate` and fails if it would produce a new migration. This catches drift between
  `src/db/schema.ts` and the committed migrations and their snapshots only; it never looks at a live database.
- Live drift (someone editing Neon by hand) is a separate check, closer to `supabase db diff`: a scheduled job
  applies `drizzle/` to a fresh database, dumps both it and production with `pg_dump --schema-only`, and fails on a
  difference. It runs against Neon with a read-only role, not on every PR.
- The database keeps integrity: foreign keys, `CHECK` constraints, unique indexes and (if ADR-0004's option is taken)
  RLS. Workflows and branching rules stay in use cases. A trigger or function that branches on business state needs
  its own ADR.

## Consequences

- An edited schema without a migration can't merge.
- A hand edit to a live database is caught by the scheduled schema comparison, not by the PR check.

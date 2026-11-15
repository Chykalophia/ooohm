# ADR-0011: Migrations-only schema changes with a drift check

- **Status:** Proposed
- **Date:** 2026-11-15

## Context

The reference's Supabase rule is "migrations only, `supabase db diff` in CI". OOOhm generates SQL with drizzle-kit
from `src/db/schema.ts` and commits it in `drizzle/`; Vercel's build runs `scripts/migrate.mts`. Nothing checks that
the committed migrations match the schema. There is no business logic in the database (no `plpgsql` functions or
triggers), only constraints.

## Decision

- CI runs `drizzle-kit generate` and fails if it would produce a new migration (the `db diff` equivalent).
- The database keeps integrity: foreign keys, `CHECK` constraints, unique indexes and (if ADR-0004's option is taken)
  RLS. Workflows and branching rules stay in use cases. A trigger or function that branches on business state needs
  its own ADR.

## Consequences

- An edited schema without a migration can't merge.
- Environments (Neon, docker, PGlite) can't drift through hand edits unnoticed.

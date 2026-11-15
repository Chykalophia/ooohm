# ADR-0004: Tenancy enforcement on Postgres + Drizzle (in place of Supabase RLS)

- **Status:** Proposed
- **Date:** 2026-11-15

## Context

The reference's Supabase rules require RLS on every exposed table, tested with pgTAP, because Supabase exposes the
database to the browser through PostgREST. OOOhm runs on Neon Postgres (or any Postgres 15+, or embedded PGlite)
through Drizzle, from server code only. No browser, anon key or PostgREST endpoint can reach the database. Tenancy
today: `company_id` always comes from the actor, every repository query is scoped by it, and a foreign id reads as
`not_found`. There is one database role. pgTAP is not available on PGlite.

## Decision

1. **Required (A8):** a generated tenant-isolation integration suite that calls every repository function with a
   second company's id and asserts it can neither read nor change the first company's rows. It runs on Postgres and
   PGlite and fails when a new repository function has no case.
2. **Required (A8):** two database roles (ADR-0006); the request-path role has no DDL and cannot `UPDATE`/`DELETE`
   `audit_log`.
3. **Recommended, decided at A8:** RLS as defence in depth on every company-scoped table, with explicit
   per-operation policies on `current_setting('app.company_id', true)`, set by `set_config('app.company_id', $1, true)`
   at the start of `inTransaction`. Transaction-scoped settings are safe behind Neon's PgBouncer pooler. Policies are
   tested with SQL assertions from `node:test` (pgTAP-equivalent), not pgTAP itself.

## Consequences

- The isolation guarantee is tested where the risk actually is (a forgotten `where company_id = …`).
- RLS adds a second net for that mistake at the cost of a session variable per transaction and policy maintenance on
  every new table; we decide with measured overhead in hand.
- Single-company self-hosted installs pay nothing extra for the tests; RLS can stay on for them too.

# ADR-0007: Keep node:test; add fakes, contracts, component tests and Playwright

- **Status:** Accepted (2026-11-14, with the plan in PR #102)
- **Date:** 2026-11-15

## Context

The reference's testing table names Vitest. OOOhm has 109 test files on Node's built-in `node:test` through `tsx`
(unit, integration on Postgres and PGlite, snapshot tests with `--test-update-snapshots`). Switching runners would
touch every file for no change in what is tested.

## Decision

- Keep `node:test` for unit, integration, architecture and contract tests.
- Component tests use React Testing Library on `node:test` with `global-jsdom`.
- End-to-end journeys use Playwright (already available in the cloud image) against `pnpm start:embedded`.
- Tier 3 ports get an in-memory fake **and** a shared contract suite that runs against both the fake and the Drizzle
  implementation, so the fake can't drift.
- Revisit Vitest only if component tests need features `node:test` lacks (watch mode UI, browser mode).

## Consequences

- No mass test rewrite; the existing suite stays the characterisation net for the whole migration.
- One deviation from the reference's tool list, recorded here.

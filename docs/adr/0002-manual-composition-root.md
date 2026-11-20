# ADR-0002: Manual composition root through ServiceContext

- **Status:** Proposed
- **Date:** 2026-11-15

## Context

The reference makes a manual composition root the default and advises against tsyringe/InversifyJS in Next.js.
OOOhm already injects a `ServiceContext` (`src/server/context.ts`: db, mailer, `now`, `defer`, secrets, webhook
target policy, adapter registry, `issueSignInLink`, `wake`), built in `src/server/runtime.ts` for the app, in
`scripts/script-context.mts` for the worker and CLI, and per test file for tests. IDs are still created with
`randomUUID()` inside 7 services.

## Decision

We will keep the manual composition root. `ServiceContext` stays the one bag of ports; we add `ids: IdGenerator`.
Each Tier 3 module gets a factory (`leaveModule(ctx)`) in `src/server/runtime.ts` that wires its ports to concrete
Drizzle repositories; tests wire in-memory fakes the same way. Nothing outside the composition roots constructs a
concrete repository for a Tier 3 module, and nothing calls a container or service locator.

## Consequences

- Fully typed; works with Next's bundling, scripts and tests alike.
- Adding a port means one field on `ServiceContext` and one line in each composition root.
- `scripts/script-context.mts` stays a second composition root (processes outside Next), documented as such.

# Modules

Each folder here is one feature module of the modular monolith (ADR-0009). A module owns its tables, its rules and
its use cases, and the rest of the app reaches it only through its `index.ts`. `reports` (a query module) and
`organisation` (CRUD, levels so far) are the two pilots: copy their shape.

## The template

```
src/modules/<m>/
  index.ts              the public API: use cases, queries, policies, schemas, DTO types
  README.md             what it owns, its public API, its tier
  application/
    use-cases/<verb>-<noun>.ts   one use case per file: (ctx, actor, input) → ServiceResult
    queries/<get|list>-<noun>.ts one read per file
    policies.ts         can<Verb><Noun>(actor): who may do what
    dto.ts              what callers get back, and the mappers from rows (to<Noun>DTO)
    schemas.ts          input parsing shared by pages, actions and routes
    ports.ts            Tier 3 only: the repository interfaces use cases depend on
  domain/               pure rules and types: no I/O, Next, Drizzle or env
  infrastructure/       drizzle-<noun>.repository.ts: Drizzle queries, each taking an executor first
  ui/                   view models for the module's screens (presenters); plain .ts, no React
```

Create only the folders a module needs. Server files (`application/`, `infrastructure/`, `index.ts`) start with
`import "server-only";`; `domain/` and `ui/` files do not.

## What each part does

- **Use cases** authorize first (a policy, then `assertActiveAdmin` or similar inside the transaction), open their
  transaction with `inTransaction(ctx, …)` or `commitThenNotify`, record every change with `recordChange` /
  `recordAdminChange` (audit + outbox), and return a `ServiceResult` (ADR-0003). Inside, they may still throw a
  `DomainError` to roll back; `attempt()` turns it into a failure once the transaction has settled.
- **Queries** read and return DTOs. One that can fail (not allowed, not found) returns a `ServiceResult`; a read
  other services use inside their own transaction takes an executor and returns plain values.
- **DTOs** are what leaves the module. Never a Drizzle row, a `$inferSelect` type or a `…Row` type
  (`tests/architecture/no-rows-exported.test.ts`).
- **Presenters** (`ui/`) turn a DTO into what a page renders: labels, links, chart items. Pages stay thin.
  React components that are specific to one route sit beside that route in `src/app`.

## Import rules

`pnpm arch` (`.dependency-cruiser.cjs`) enforces them; every rule below is an error with no baseline.

- Outside a module, import only `@/modules/<m>` (`no-deep-import-from-outside`).
- One module imports another only through its index (`no-deep-import-across-modules`). The module graph stays
  acyclic (`pnpm madge`).
- Inside a module (`module-layers`): `domain` imports none of the module's `application`, `infrastructure` or `ui`;
  `application` and `infrastructure` never import `ui`; `ui` never imports `infrastructure`.
- A module's `domain` imports only its own domain, `src/shared/kernel` and `src/shared/lib/result.ts`
  (`module-domain-is-pure`).
- A module may use the old `src/server/services`, `src/server/repositories`, `src/domain` and `src/lib` code that
  has not moved yet. When old code needs something a module now owns, the module exports a small query from its
  index; never its repository.
- Tests may import a module's internals (a domain function, say) to test them directly.

## Tier 2 and Tier 3

- **Tier 2** (everything but leave, approvals and balances): `application` calls its own `infrastructure`
  repositories directly. No port without a second implementation.
- **Tier 3** (leave, approvals, balances): aggregates and value objects in `domain`, repository ports in
  `application/ports.ts` with a Drizzle implementation and an in-memory fake, and use-case tests on the fakes.
  `application` never imports `infrastructure`; the composition root wires them (`module-layers`).

## Adding a module

1. Create `src/modules/<m>/` with `index.ts`, `README.md` and the folders you need.
2. Move code with `git mv` (a move is a rename), fix every import (src, tests, scripts, site/demo), and delete the
   old file.
3. Return `ServiceResult` from use cases and queries that can fail, and DTOs from everything in the index.
4. Write the README: tables owned, public API, tier.
5. Run `pnpm arch`, `pnpm madge`, `pnpm test` and both integration suites.

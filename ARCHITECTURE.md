# OOOhm architecture map

A short map of the codebase. [docs/architecture.md](docs/architecture.md) has the detail: events, audit,
attribution, dates, email, leave rules and paging.

OOOhm follows Chykalophia's *SaaS Layered Architecture Reference*. It is **in transition**: today's code is layered
by layer, and the target is a modular monolith with feature modules that are layered inside. The migration plan
is in [docs/architecture-plan/](docs/architecture-plan/README.md), and the decisions behind it are in
[docs/adr/](docs/adr/).

## The dependency rule

```
Presentation ──► Application ──► Domain ◄── Infrastructure
 src/app          services /       src/domain     repositories, src/db,
 shared UI        module use cases  module domain  src/lib, adapters
```

Source dependencies point inward only. The domain imports nothing outside itself. Only infrastructure knows a
database or a vendor SDK exists. The composition root (`src/server/runtime.ts`, and `scripts/script-context.mts`
for processes outside Next) is the only place that wires concrete implementations to the `ServiceContext`.
`pnpm lint` enforces these rules today. From phase A0, dependency-cruiser (`pnpm arch`) enforces them in CI too.

## Where code lives today

| Path | Layer | Notes |
| --- | --- | --- |
| `src/app/**` | Presentation | Thin pages, server actions through the action pipeline (`src/app/_lib/server-action.ts`), route handlers |
| `src/components/**` | Presentation (UI kit) | Renders props; never loads data |
| `src/server/services/**` | Application | Use cases, transactions, authorization against data, audit + outbox, email after commit |
| `src/server/repositories/**` | Infrastructure | Drizzle queries only; each takes an executor first |
| `src/shared/kernel/**`, `src/shared/lib/**` | Shared | Pure kernel rules; `ServiceResult`, the unit of work (`inTransaction`), admin checks, `recordChange` and other repository helpers (`lib/db/`) |
| `src/server/integrations/**`, `importers/**` | Ports / infrastructure | Adapter seam; one-time import readers |
| `src/domain/**` | Domain | Pure rules and types; no I/O |
| `src/lib/**`, `src/db/**` | Infrastructure + cross-cutting | Env, auth, logging, mail, crypto; schema and connection |
| `src/modules/<m>/**` | All four, inside the module | `reports`, `organisation` (company, appearance, departments, levels, leave types), `notifications` (emails, Admin → Emails), `audit` (the audit log viewer) `leave` and `balances` (Tier 3: aggregates or strategies, ports, in-memory fakes and a repository contract) so far; template and import rules in [src/modules/README.md](src/modules/README.md) |

## Where code is going

```
src/app/                 routes only, thin
src/modules/<m>/         ui/ application/ domain/ infrastructure/ index.ts README.md
src/server/              context.ts, runtime.ts, admin/ (privileged DB), identity/, jobs/
src/shared/              kernel/ (shared domain types), lib/ (result, log, env, …), ui/ (UI kit)
```

The modules are leave, approvals and balances (Tier 3), plus calendar, holidays, people, organisation,
notifications, integrations, reports, audit and import (Tier 2). See
[02-target-modules-and-tiers.md](docs/architecture-plan/02-target-modules-and-tiers.md).

Outside a module, code imports only `@/modules/<m>` (its `index.ts`); `pnpm arch` enforces it and the layers inside
each module.

**Rule for new code during the transition:** when a module already exists in `src/modules/`, put the code there.
When it doesn't, follow today's layout. Either way, a use case takes `(ctx, actor, input)`, authorizes it, and
returns what the screen needs (a DTO, not a row).

## Decision table (short)

| The code… | Goes in |
| --- | --- |
| is a page, layout, server action or route handler | `src/app/…`, thin: parse → one use case → map the result |
| runs one use case | `modules/<m>/application/use-cases/` (today: `src/server/services/`) |
| decides whether an actor may do X | `modules/<m>/application/policies.ts` (today: `src/domain/*-permissions.ts`) |
| is a business rule | `modules/<m>/domain/` (today: `src/domain/`) |
| reads or writes the database | `modules/<m>/infrastructure/` (today: `src/server/repositories/`) |
| talks to a vendor (SMTP, Better Auth, webhooks out) | infrastructure, behind a port on `ServiceContext` |
| is used by 3+ modules | `src/shared/` |
| needs the database owner role | `src/server/admin/` only (ADR-0006) |

## Checks

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration` (Postgres) and
`pnpm test:integration:embedded` (PGlite). Phase A0 adds `pnpm arch` and a GitHub Actions workflow that runs all of
them on every PR.

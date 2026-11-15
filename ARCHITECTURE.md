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
 src/app          module use cases  module domain  repositories, src/db,
 shared UI                          shared kernel  src/lib, adapters
```

Source dependencies point inward only. The domain imports nothing outside itself. Only infrastructure knows a
database or a vendor SDK exists. The composition root (`src/server/runtime.ts`, and `scripts/script-context.mts`
for processes outside Next) is the only place that wires concrete implementations to the `ServiceContext`.
`pnpm lint` enforces these rules today. From phase A0, dependency-cruiser (`pnpm arch`) enforces them in CI too.

## Where code lives today

| Path | Layer | Notes |
| --- | --- | --- |
| `src/app/**` | Presentation | Thin pages (a module presenter, components beside the route), server actions beside their route through the action pipeline (`src/app/_lib/server-action.ts`, with a per-person rate limit), route handlers; they import only module indexes and the presentation helpers (F12, `pnpm arch`) |
| `src/components/**` | Presentation (UI kit) | Renders props; never loads data |
| `src/shared/kernel/**`, `src/shared/lib/**` | Shared | The kernel: pure rules and types several layers share, no I/O (client components and the schema import it too); `ServiceResult`, the unit of work (`inTransaction`), the tenant scope (`forTenant`) and the pre-tenant lookups, admin checks, `recordChange` and the shared reads and repository helpers (`lib/db/`) |
| `src/server/integrations/**` | Ports | Adapter seam (the port `ServiceContext` names) |
| `src/lib/**`, `src/db/**` | Infrastructure + cross-cutting | Env, auth, logging, mail, crypto; schema and connection |
| `src/modules/<m>/**` | All four, inside the module | `reports`, `organisation` (company, appearance, departments, levels, leave types), `notifications` (emails, Admin → Emails), `audit` (the audit log viewer), `integrations` (webhooks, API keys, the REST API, adapters, outbox jobs; event contracts in `tests/contracts`), `import` (the CLI-only TimeOff import), `holidays` (Admin → Holidays), `calendar` (calendar views, feeds, the `calendarScopeFor` loader), `people` (Admin → People, the teammate page, the account page), `leave`, `balances` and `approvals` (Tier 3: aggregates or strategies, ports, in-memory fakes and repository contracts; approvals implements leave's `ApprovalRouter`, wired in `src/server/wiring.ts`) so far; template and import rules in [src/modules/README.md](src/modules/README.md) |

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
| turns a DTO into what a page shows (labels, links, wording) | `modules/<m>/ui/` (a presenter: plain functions, no React) |
| runs one use case | `modules/<m>/application/use-cases/` |
| decides whether an actor may do X | `modules/<m>/application/policies.ts` |
| is a business rule | `modules/<m>/domain/`, or `src/shared/kernel/` when client components, the schema or several modules use it |
| reads or writes the database | `modules/<m>/infrastructure/`, or `src/shared/lib/db/` when modules below the owner read it too |
| talks to a vendor (SMTP, Better Auth, webhooks out) | infrastructure, behind a port on `ServiceContext` |
| is used by 3+ modules | `src/shared/` |
| needs the database owner role | `src/server/admin/` only (ADR-0006) |

## Checks

`pnpm typecheck` (one pass over the whole repository, tests and scripts included, with `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride` and `noFallthroughCasesInSwitch` in `tsconfig.json`), `pnpm lint`, `pnpm arch`,
`pnpm madge`, `pnpm test`, `pnpm test:integration` (Postgres) and `pnpm test:integration:embedded` (PGlite), all run
by the GitHub Actions workflow on every PR. No check has a baseline: `pnpm arch` reports every violation, and every
server file imports `server-only`.

Fitness checks that guard what no single test sees:

- `tests/integration/tenancy.test.ts` runs every exported use case, query and API route as one company's actor
  against two seeded companies, and fails if the other company's rows change or its data shows up.
  `tests/architecture/tenancy-coverage.test.ts` fails when an export has neither a case nor an exemption with a reason.
- Row-level security (ADR-0004) is the second net: `tests/integration/rls.test.ts` checks every tenant table's
  policies in SQL as the app role on both drivers, and `tests/architecture/row-level-security.test.ts` fails when a
  `company_id` table lacks its policies or an unlisted `SECURITY DEFINER` function appears.
- `pnpm db:check-drift` fails when `src/db/schema.ts` and the committed migrations in `drizzle/` disagree.
- `pnpm test:e2e` (after `pnpm build`) drives the built app on `pnpm start:embedded` in Chromium: invite-only
  sign-in through the emailed link, inviting people, and a request from submission to approval and cancellation.

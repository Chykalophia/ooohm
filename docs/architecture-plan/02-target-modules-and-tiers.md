# 2. Target modules and tiers

OOOhm stays one deployable: a **modular monolith**. Each business area becomes a module under `src/modules/<name>/`,
layered inside, reachable from other code only through its `index.ts`. Tiers are per module (reference §10):
**Tier 2 is the default**, Tier 3 only where real invariants live.

## 2.1 Target tree

```
src/
  app/                      # Presentation: routes only (pages, layouts, actions.ts, route.ts), thin
    _lib/                   # presentation pipelines: page loaders, action pipeline, API handler
  modules/
    leave/                  # Tier 3
      ui/                   # presenters, view models, route-agnostic components
      application/
        use-cases/          # submit-leave-request.ts, cancel-leave-request.ts, … one per file
        queries/            # get-dashboard.ts, list-my-requests.ts, …
        policies.ts         # canCancel, canAddFor, …
        dto.ts              # LeaveRequestDTO, DashboardDTO
        schemas.ts          # zod input schemas (moved from src/app/_lib/leave-input.ts)
        ports.ts            # LeaveRequestRepository, … (Tier 3 only)
      domain/               # LeaveRequest aggregate, DateRange, DayCount, status machine, events, errors
      infrastructure/       # drizzle-leave-request.repository.ts, mappers
      index.ts              # public API
      README.md             # what the module owns and exports
    approvals/  balances/   # Tier 3
    calendar/  holidays/  people/  organisation/  notifications/  integrations/  reports/  audit/  import/
  server/
    context.ts              # ServiceContext type (ports: db, mailer, clock, ids, secrets, …)
    runtime.ts              # composition root: builds the context and the module services, per request
    admin/                  # privileged database handle (migrations, worker, cron, import) — ADR-0006
    identity/               # Better Auth config, requireActor, passkeys (cross-cutting authN)
    jobs/                   # runTick, scheduled jobs, retention, outbox dispatch
  shared/
    kernel/                 # calendar-date, day counting, change-source, actor, ids (branded), paging, text
    lib/                    # result.ts, errors.ts, log.ts, env.ts, crypto, rate-limit, safe-fetch
    ui/                     # today's src/components (ui, forms, layout, navigation, charts)
  db/                       # schema.ts, connect.ts, config.ts (infrastructure, shared by module repositories)
drizzle/                    # migrations only
docs/adr/                   # architecture decision records
ARCHITECTURE.md  AGENTS.md
```

Why `src/db/schema.ts` stays one file: drizzle-kit generates migrations from one schema and several modules join
the same tables (leave requests ⋈ users ⋈ leave types). Each module's repositories import only the tables they own
or read; a fitness rule lists which module may import which table (ADR-0009). Splitting the schema per module is
possible later without changing migrations.

## 2.2 Tier per module

| Module | Tier | Why | Domain it owns (today's files) |
| --- | --- | --- | --- |
| **leave** | **3** | Real invariants: legal status transitions, no overlaps, half days on one date only, day counts with one decimal that skip weekends and holidays, past-year approved leave can't be cancelled, rate limit per person, coverage warnings | `leave-request`, `request-status`, `overlap`, `leave-days`, `coverage`, `leave-permissions`, `holidays` (counting) |
| **approvals** | **3** | One approver per person (manager → department manager → admin), self-approval, reassignment when people change, signed email approval, approval modes | `approval-rule`, parts of `leave-permissions` |
| **balances** | **3** | Allowance policy is pluggable, most-specific allowance rule wins, carryover per leave type (off by default), year rollover is idempotent, every change audited | `allowance-policy`, `allowance-rules`, balance parts of `leave-days` |
| calendar | 2 + domain | One visibility rule (`calendarScopeFor`) that every colleague-facing screen must use; feeds with tokens | `calendar`, `calendar-visibility`, `calendar-feed`, `ics` |
| holidays | 2 + domain | Multi-day ranges, recount of affected requests (calls leave's public API) | `holidays` (ranges) |
| people | 2 + domain | Invite-only creation, deactivation, deletion lifecycle with grace period and scrub (privacy invariants), CSV import | `people`, `person`, `person-deletion`, `people-import`, `csv` |
| organisation | 2 | Company settings, appearance/themes, departments, levels, leave-type catalog: CRUD with validation | `company-settings`, `appearance`, `color-mode`, `company-logo`, `leave-type-settings`, `admin-permissions` |
| notifications | 2 | Catalog + pure templates + after-commit send; editable copy rules | `email-template` |
| integrations | 2 + contract tests | Webhooks, API keys, v1 API, adapter seam, outbox delivery; the event payloads are a **public contract** | `integrations`, `webhook-target`, `events` (envelope) |
| reports | 2 (query module) | Read model only; no writes | `reports` |
| audit | 2 | Audit viewer; `recordChange` is shared kernel used by every writer | `audit`, `change-source` (kernel) |
| import | 2 (isolated) | One-time TimeOff import; large but stable, own transaction; keep isolated, split files | `timeoff/*` |
| identity (server/identity) | cross-cutting | Sign-in, passkeys, sessions, `requireActor` | `actor`, `install` |
| jobs (server/jobs) | cross-cutting | The background tick and daily jobs; receive → verify → call a module | — |

Tier 3 adds, per module: aggregates and value objects in `domain/`, repository **ports** in `application/ports.ts`
with a Drizzle implementation and an **in-memory fake**, use-case tests on the fakes, domain events raised by the
aggregate and written to `events_outbox` by the use case (already the pattern; it becomes explicit).

Tier 2 modules keep calling their repositories directly ("CRUD slices call the repository directly"; no port
without a second implementation).

## 2.3 Where each existing file goes

| Today | Target |
| --- | --- |
| `src/server/services/leave-requests.ts`, `leave-on-behalf.ts`, `leave-recount.ts`, `leave-changes.ts`, `also-off.ts` | `modules/leave/application/{use-cases,queries}/*` |
| `src/server/services/approvals.ts`, `approval-routing.ts`, `email-approval.ts` | `modules/approvals/application/*` (breaks cycle 5: one module) |
| `src/server/services/balances.ts`, `allowance-changes.ts`, `admin-allowances.ts`, `admin-allowance-rules.ts`, `rollover.ts` | `modules/balances/application/*` |
| `src/server/services/calendar*.ts`, `team-member.ts` | `modules/calendar/application/*` |
| `src/server/services/admin-holidays.ts` | `modules/holidays/application/*` |
| `src/server/services/admin-people*.ts`, `account.ts` | `modules/people/application/*` |
| `src/server/services/admin-company.ts`, `appearance.ts`, `admin-departments.ts`, `admin-levels.ts`, `admin-leave-types.ts` | `modules/organisation/application/*` |
| `src/server/notifications/**`, `services/notify.ts`, `services/admin-emails.ts` | `modules/notifications/*`; `commitThenNotify` → `shared/lib/unit-of-work.ts` |
| `src/server/services/webhooks.ts`, `webhook-delivery.ts`, `api-keys.ts`, `api-v1.ts`, `integrations.ts`, `inbound-sync.ts`, `adapter-delivery.ts`, `src/server/integrations/**` | `modules/integrations/*` |
| `src/server/services/reports.ts` | `modules/reports/application/queries/*` |
| `src/server/services/audit-log.ts`, `admin-access.ts` | `modules/audit/*`; `assertCanAdminister`, `lockCompany`, `recordAdminChange` → `shared/kernel` (used by most modules) |
| `src/server/services/background-tick.ts`, `scheduled-jobs.ts`, `retention.ts`, `outbox-dispatch.ts`, `health.ts`, `install.ts` | `src/server/jobs/*`, `src/server/identity/install.ts` |
| `src/server/services/timeoff-import.ts`, `src/server/importers/**`, `src/domain/timeoff/**` | `modules/import/*` |
| `src/server/repositories/<x>.ts` | the owning module's `infrastructure/`; `change-log.ts`, `keyset.ts`, `errors.ts` → `shared/lib/db/` |
| `src/domain/<x>.ts` | the owning module's `domain/`, or `shared/kernel/` when used by 3+ modules (`calendar-date`, `leave-days` counting core, `change-source`, `actor`, `ids`, `paging`, `text`, `errors`) |
| `src/components/**` | `src/shared/ui/**` (no behaviour change; path alias kept during the move) |
| `src/lib/auth.ts`, `auth-client.ts`, `passkey-rp.ts`, `setup-token.ts` | `src/server/identity/` (`auth-client.ts` stays client-safe in `shared/lib`) |
| `src/lib/*` (env, log, mail, crypto, safe-fetch, rate-limit, format, email-layout) | `src/shared/lib/*` or `src/server/<concern>/` for server-only pieces |
| `src/app/_lib/leave-input.ts`, `calendar-input.ts`, `report-input.ts`, `form-fields.ts` | each module's `application/schemas.ts` (`form-fields` → `shared/lib/form-fields.ts`) |

Moves are done **one module per PR**, with the old path re-exporting the new one for that PR only, so a move is a
pure rename that the existing integration suite proves.

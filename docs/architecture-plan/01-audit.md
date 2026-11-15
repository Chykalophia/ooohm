# 1. Current-state audit

Audited on 2026-11-15 against the agency's *SaaS Layered Architecture Reference* (Nov 14, 2026), at `main`
`6723a35`. Every number below was measured, not estimated; the commands are in
[04-fitness-functions.md](04-fitness-functions.md#how-the-baseline-was-measured) so they can be re-run.

## Summary

OOOhm is already layered, but it is layered **by layer first** (`src/app` → `src/server/services` →
`src/server/repositories` → `src/domain`), and the dependency direction is enforced by ESLint
`no-restricted-imports`. A dependency-cruiser pass written to the reference's rules found **no layer-skipping
imports and no vendor SDK outside infrastructure**. The real gaps are structural rather than leaks:

| Area | Reference asks for | OOOhm today | Gap |
| --- | --- | --- | --- |
| Organisation | Feature modules, layered inside, public `index.ts` | Layer-first folders; 46 services in one flat folder | **Large**: no module boundaries; 101 service-to-service imports |
| Dependency rule | Inward only, CI-enforced | Inward only, ESLint-enforced | Small: add dependency-cruiser + baseline in CI |
| Cycles | `no-circular: error` | **5 cycles** (3 in domain, 1 integrations, 1 services) | Medium |
| Results | Use cases return `ServiceResult<DTO>`; expected failures are values | Services **throw** `DomainError` (198 throws in services, 79 in domain); the action pipeline maps codes | **Large**, but mechanical behind the pipeline |
| DTOs | DTOs to the client; no rows across boundaries | Client props are already shaped; services return Drizzle row types (`LeaveRequestRow`, `HolidayRow`, `PersonRow`, …) | Medium |
| `server-only` | In every application, infrastructure and DAL file | In **11 of ~130** server files (0 of 46 services, 0 of 29 repositories) | Medium, mechanical |
| Auth in actions | Every action built from an authenticated client | Every action goes through `runFormAction` / `adminAction` (the pipeline calls `requireActor`) except 2 token-credentialed ones, which the service verifies | Compliant; needs a fitness function |
| Ports | Only at real seams | `ServiceContext` already injects `Mailer`, `now`, `SecretBox`, `AdapterRegistry`, `issueSignInLink`; repositories are concrete | Small: add `IdGenerator`; repository ports only for the Tier 3 modules |
| Size limits | Actions/routes ≤100 lines, functions ≤~50, services ≤500 | 2 action files over 100; 25 service functions over 50 (largest 458); 3 service files over 500 | Medium |
| Tenancy in the DB | RLS on every exposed table (Supabase) | No RLS; tenancy is `company_id` from the actor, in every repository query | Needs an ADR for this stack (no browser DB access exists) |
| Type safety | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` | `strict` only. Turning on the other two: ~140 / ~60 errors in `src` | Medium |
| Tests per layer | Domain unit, use-case with fakes, infra integration, contract, component, e2e | Domain unit (40/42 files), service integration on real Postgres **and** PGlite (41 files), email snapshots | Missing: in-memory fakes, component tests, contract tests, Playwright journeys |
| CI | Fitness functions fail CI on new violations | **There is no CI.** No `.github/workflows`; Vercel runs only migrate + build | **Large**: everything else depends on it |
| Docs | `ARCHITECTURE.md`, `AGENTS.md`, `docs/adr/`, a README per module | `AGENTS.md` + a detailed `docs/architecture.md`; no ADRs, no per-module README | Small |

The app's existing strengths should be kept, not rewritten: the action pipeline (`src/app/_lib/action-pipeline.ts`)
is already the reference's "authenticated action client"; `ServiceContext` + `src/server/runtime.ts` is already a
manual composition root; `recordChange` writes audit + outbox in one transaction (the reference's Tier 3 outbox);
the domain is pure and ESLint-guarded.

## 1.1 Module map (as it is)

Lines are non-test TypeScript, measured with `wc -l`.

| Directory | Files | Lines | Reference layer |
| --- | ---: | ---: | --- |
| `src/app/**` | 128 | 10,049 | Presentation (pages, actions, route handlers, route components) |
| `src/components/**` | 55 | 4,435 | Presentation (shared UI kit) → `src/shared/ui` |
| `src/server/services/**` | 46 | 9,318 | Application (use cases, policies, transactions) |
| `src/server/repositories/**` | 29 | 4,090 | Infrastructure (repositories) |
| `src/server/notifications/**` | 10 | 722 | Application (catalog) + Presentation-ish (templates) + Infrastructure (send) |
| `src/server/integrations/**` | 2 | 121 | Domain port (`Adapter`) + registry |
| `src/server/importers/**` | 1 | 334 | Infrastructure (SQLite reader) |
| `src/domain/**` | 42 | 7,137 | Domain |
| `src/lib/**` | 33 | 2,163 | Infrastructure + cross-cutting (auth, env, log, mail, crypto, rate limit) |
| `src/db/**` | 7 | 1,332 | Infrastructure (schema, connection, driver choice) |
| `src/server/context.ts`, `runtime.ts` | 2 | — | Composition root |

How today's services group into business areas (the future modules, see
[02-target-modules-and-tiers.md](02-target-modules-and-tiers.md)):

| Business area | Services today |
| --- | --- |
| Leave requests | `leave-requests`, `leave-on-behalf`, `leave-recount`, `leave-changes`, `also-off` |
| Approvals | `approvals`, `approval-routing`, `email-approval` |
| Balances & allowances | `balances`, `allowance-changes`, `admin-allowances`, `admin-allowance-rules`, `rollover` |
| Calendar & visibility | `calendar`, `calendar-scope`, `calendar-feeds`, `team-member` |
| Holidays & working time | `admin-holidays` (+ recount via `leave-recount`) |
| People | `admin-people`, `admin-people-deletion`, `admin-people-import`, `account` |
| Organisation settings | `admin-company`, `appearance`, `admin-departments`, `admin-levels`, `admin-leave-types` |
| Notifications | `notify`, `admin-emails`, `src/server/notifications/**` |
| Integrations & API | `webhooks`, `webhook-delivery`, `outbox-dispatch`, `api-keys`, `api-v1`, `integrations`, `inbound-sync`, `adapter-delivery` |
| Reports | `reports` |
| Audit | `audit-log`, `admin-access` (`assertCanAdminister`, `lockCompany`, `recordAdminChange`) |
| Platform & jobs | `background-tick`, `scheduled-jobs`, `retention`, `health`, `install` |
| One-time import | `timeoff-import`, `src/server/importers/**`, `src/domain/timeoff/**` |

Fan-in hot spots inside services (imports by other services): `notify` 23, `admin-access` 17, `balances` 11,
`approval-routing` 6, `leave-changes` 5. These become shared-kernel or module public APIs.

## 1.2 Dependency-rule violations

Measured with dependency-cruiser 16 using the rules in
[04-fitness-functions.md](04-fitness-functions.md#draft-dependency-cruiser-config) (395 modules, 2,111 dependencies).

| Rule | Count | Detail |
| --- | ---: | --- |
| Domain imports anything outside `src/domain` | **0** | ESLint already forbids it |
| `src/app` imports repositories, `src/db` runtime or Drizzle | **0** | |
| `src/components` imports `src/server`, `src/db`, `src/app` | **0** | |
| Services import `db`/`env`/`auth`/`mail` or a vendor SDK | **0** | Services import only `@/db/types` (type-only) |
| Vendor SDK (`drizzle-orm`, `better-auth`, `nodemailer`, `postgres`, PGlite) outside `src/lib`, `src/db`, repositories, runtime | **0** | |
| `src/app/api/auth/[...all]/route.ts` → `better-auth/next-js` | 1 | Accepted: the auth framework's own mount point (ADR-0005) |
| `src/lib/auth.ts` → `drizzle-orm` | 1 | Accepted: the Better Auth adapter is infrastructure; moves to `src/server/identity/infrastructure` |
| Circular dependencies | **5** | below |
| Service → concrete repository | 165 edges | Allowed at Tier 2 ("CRUD slices call the repository directly"); replaced by ports only in Tier 3 modules |
| Service → another service (no module boundary) | 101 edges | Becomes "cross-module through `index.ts` only" |

The five cycles (`madge --circular`):

1. `domain/errors.ts` ⇄ `domain/person-deletion.ts` (`errors` imports the `DeletionBlockers` detail type).
2. `domain/errors.ts` → `person-deletion` → `events` → `calendar-feed` → `calendar` → `leave-request` → `errors`.
3. `domain/errors.ts` → `person-deletion` → `events` → `company-logo` → `errors`.
4. `server/integrations/adapter.ts` ⇄ `installed.ts` (the registry and its contents in one cycle).
5. `services/approvals` → `approval-routing` → `email-approval` → `approvals`.

Cycles 1–3 share one root: an error-detail type living in a feature file. Cycle 5 is the clearest sign of a missing
module boundary (approvals and email approval are one module).

## 1.3 Fat controllers and fat use cases

Reference limits: action/route file ≤ 100 lines, function ≤ ~50, use-case file ≤ 500.

**Action and route files over 100 lines:** `src/app/admin/people/actions.ts` (185, 8 actions),
`src/app/admin/webhooks/actions.ts` (124, 7 actions). Both are thin per action; they are long because one file holds
many actions. `peopleImportAction` (57 lines) is the one action function over 50. Every route handler is ≤ 80 lines
(`api/leave-preview` 80, `admin/people/[id]/export` 52); the v1 API routes are one line each through
`_lib/api-get.ts`.

**Service files over 500 lines:** `timeoff-import.ts` 824, `admin-people-deletion.ts` 678, `admin-people.ts` 577
(`leave-requests.ts` 408 is next).

**Service functions over 50 lines (25):** the largest are `runImport` 458, `submitLeaveRequest` 110 (its transaction
callback 98), `getDashboard` 83, `recountLeave` 83, `executeDeletion` 81, `importPeople` 80, `exportPersonRecords` 78,
`redactStoredMentions` 75, `getTeamMember` 75, `rollMember` 68, `removeLeaveFor` 67, `reconcile` 66,
`deliverDueWebhooks` 65, `addLeaveFor` 64, `runTick` 62, `getLeaveReport` 62, `syncBalances` 60. Repositories have
none.

**Domain functions over 50 lines (5):** `buildImportPlan` 507 (TimeOff mapping), `planPeopleImport` 110,
`buildLeaveReport` 91, `parseCsv` 61.

**Pages over 150 lines:** `reports/page.tsx` 372, `admin/audit/page.tsx` 271, `admin/appearance/page.tsx` 228,
`admin/webhooks/[id]/page.tsx` 168, `calendar/page.tsx` 167, `approvals/page.tsx` 166. These hold presentation
(formatting, grouping) that the reference puts in a presenter under `modules/<f>/ui/`.

**Components:** 47 functions in `src/app` and 16 in `src/components` exceed 50 lines, almost all JSX
(`MonthGrid` 231, `DatePicker` 289, `SortableList` 262). The plan applies a separate, looser limit to `.tsx` and
splits only where logic, not markup, is long.

**Mutations during render:** none found. Pages call read services only; writes go through server actions.

## 1.4 Raw rows to the client

- **No client component imports `src/server`, `src/db` or a repository type.** The five client components that
  import types take domain view types (`CalendarDay`, `CalendarViewEntry`, `CalendarDate`, `FeedKind`, …).
- Props passed to client components are already presenter-shaped (for example `ApprovalItem` gets
  `requestId, label, who, dates`).
- **But services return Drizzle row types**, so nothing stops a page from passing a whole row to a client
  component. Exported row types: `LeaveRequestRow`, `AllowanceRow`, `CalendarFeedRow`, `ImportRunRow`,
  `HolidayRow`, `PersonRow`, `CompanyRow`. Services that return them: `submitLeaveRequest`, `cancelLeaveRequest`,
  `listHolidaysForAdmin`, `addHoliday(s)`, `renameHoliday(s)`, `invitePerson`, `resendInvite`, `reactivatePerson`,
  and more.
- No `NEXT_PUBLIC_` variables exist; `process.env` is read only in `src/lib/env.ts`, `worker-env.ts`, `log.ts`,
  `db/index.ts`, `db/connect.ts` and `instrumentation.ts`.
- React's taint APIs are not used.

## 1.5 Auth placement

- **Pages:** every signed-in page opens with `requireMemberPage()` / `requireAdminPage()`
  (`src/app/_lib/page-context.ts`).
- **Server actions:** 19 `"use server"` files, 54 exported actions. 52 go through the pipeline
  (`runFormAction`, `runStateAction`, `runActionThenGo`, or `adminAction*`), which calls `requireActor()` before the
  schema and the service. Two are deliberately sessionless and credentialed by a token the **service** verifies:
  `approveFromEmailAction` (signed approve token) and `runSetupAction` (setup token).
- **Services re-check:** admin services call `assertCanAdminister`; every query is scoped by `actor.companyId`; a
  foreign id reads as `not_found`.
- **Route handlers:** the v1 API goes through `_lib/handler.ts` (API key, scopes, rate limit); `cron/tick` checks
  `CRON_SECRET`; `ics/[file]` checks a feed token; `logo`, `favicon.svg`, `health` and `openapi.json` are public by
  design.
- **Proxy/middleware:** none, so there is no "middleware-only auth".
- **Identity:** `auth.api.getSession()` (Better Auth) with the cookie cache **off** (the default), so every call reads
  the `session` table: the equivalent of Supabase's `getUser()`, not `getSession()` (ADR-0005).

Compliant today; what is missing is a **fitness function** that fails CI when a new action or route skips it.

## 1.6 Missing `server-only`

`import "server-only"` appears in 11 files: `src/server/runtime.ts`, six files in `src/app/_lib`,
`src/app/admin/admin-action.ts`, `src/app/api/v1/_lib/api-get.ts`, `src/lib/auth.ts`, `src/lib/log.ts`,
`src/lib/mail/index.ts`. Missing from every service (46), repository (29), notification file (10), integration (2),
importer (1), `src/db/**` (7) and the server-side `src/lib` files (`env`, `integration-crypto`, `token-hash`,
`feed-token`, `setup-token`, `email-link-token`, `safe-fetch`, `rate-limit`, …). Today ESLint's component rules stop a
client import of these, but the build would not.

Scripts and tests already run with `--conditions=react-server`, so adding `server-only` everywhere breaks nothing.

## 1.7 Errors and results

- Expected failures: `DomainError` with a stable `code` and optional structured `details` (`src/domain/errors.ts`).
  Thrown 198 times in services and 79 in the domain.
- Presentation maps codes to calm messages (`run-action.ts`, `messageForError`) and the API maps them to HTTP
  statuses (`api/v1/_lib/handler.ts`). Stack traces never reach the browser; the logger redacts query parameters
  and SMTP replies.
- The reference asks for `ServiceResult<T>` at the use-case boundary. The codes and mapping already exist, so the
  migration is a wrapper, not a rewrite (ADR-0003).

## 1.8 Cross-cutting

| Concern | Today | Gap |
| --- | --- | --- |
| Middleware | The action pipeline and the API handler compose auth, parsing, rate limit and error mapping | None; name them as the two pipelines |
| Logging | `src/lib/log.ts`, structured, redacting | No request id / trace id |
| Clock | `ctx.now()` | Fine |
| IDs | `randomUUID()` called directly in 7 services | Add `ctx.ids` (`IdGenerator`) |
| Jobs | `runTick` (worker, cron route, inline, embedded timer) | Already "receive, verify, call a service" |
| Feature flags | Env flags in `env.ts` (`WEBHOOK_ALLOW_*`, background mode) | No interface; low priority |
| Caching | React `cache()` per request for the session; Cache Components off | Fine |
| Env | `src/lib/env.ts` (zod, trimmed), `worker-env.ts` | Fine |
| Rate limits | Leave submits (10 / 10 min, in the service), API keys | Server actions in general have none |

## 1.9 Test coverage per layer

| Layer | What exists | Files | Gap against the reference |
| --- | --- | ---: | --- |
| Domain | Pure unit tests (`node:test`), no mocks | 68 unit files cover 40 of 42 domain files (`text`, `ids` untested) | Good |
| Application | Service tests on a **real** database, fresh per file, run on Postgres and on PGlite | 41 integration files cover 39 of 46 services | No in-memory fakes, so use-case tests are slow and need a DB. Untested directly: `health`, `admin-access`, `allowance-changes`, `calendar-scope`, `leave-changes`, `approval-routing`, `leave-recount` (covered through callers) |
| Infrastructure | Repositories tested only through services (5 of 29 imported by a test); `migrations.test.ts` | — | No repository-level tests; no tenancy-isolation test that tries a foreign `company_id` on every repository |
| External contracts | `tests/unit/email-output.test.ts` snapshots every email; `api.test.ts` checks the OpenAPI document | — | No contract tests for webhook payloads / event envelopes (a public contract per `docs/api.md`) |
| Presentation | `action-pipeline.test.ts`, `form-state.test.ts`, date-picker tests | 5 of 55 shared components imported by a test | No component tests |
| End to end | `tests/e2e/*.mts` are demo/setup scripts, not tests | — | No Playwright journeys; no per-role or tenant-isolation journey |

The runner is Node's built-in `node:test` through `tsx`, not Vitest (ADR-0007).

## 1.10 Type safety

`strict: true`. Measured errors when turning on the reference's extra flags:

| Flag | `src` | tests, scripts, site |
| --- | ---: | ---: |
| `noUncheckedIndexedAccess` | ~140 | ~2,600 (mostly `rows[0]` in integration tests) |
| `exactOptionalPropertyTypes` | ~62 | ~16 |

IDs are plain `string` everywhere (validated by `isUuid` at the edges). No branded types.

## 1.11 Database and tenancy

- 26 tables, 30 migrations (`drizzle/0000` … `0029`), generated by drizzle-kit and committed. No dashboard edits.
- No RLS, no `plpgsql` functions or triggers: business logic is not in the database. `CHECK` constraints guard
  invariants such as the audit actor shape.
- One database role for the app, the worker, migrations and the seed.
- No browser ever talks to the database (no Supabase client, no PostgREST), which changes the threat model behind
  the reference's RLS rules (ADR-0004).

## 1.12 CI and delivery

- No GitHub Actions. `pnpm typecheck`, `pnpm lint`, `pnpm test` and both integration suites run only when a person
  or agent runs them.
- Vercel's `vercel-build` migrates, seeds once and builds. Merging to `main` deploys production.
- So today **no rule in this document is enforced on merge.** Phase 0 fixes that first.

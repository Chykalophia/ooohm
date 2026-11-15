# 3. Phased plan (TDD first)

Nine phases, **A0 to A8**, each shipped as one or more PRs that keep the app's behaviour unchanged. The project rule
"one milestone per PR" applies: a phase's PRs never mix with feature work.

## Ground rules for every phase

1. **The safety net is the existing suite.** The 41 integration files (Postgres **and** PGlite), the 68 unit files and
   the email snapshots (`tests/unit/email-output.test.ts.snapshot`) are the characterisation tests. They stay green on
   every PR and their assertions don't change during a move. A test that must change is changed in its own commit
   with a reason.
2. **Red first.** Each step starts with a failing test or a failing fitness function, then the change that turns it
   green, then the refactor. The "Tests first" lists below are written before any production code in that phase.
3. **Moves are renames.** A file move PR contains moves, import rewrites and a temporary re-export at the old path,
   nothing else. Behaviour changes are never mixed into a move.
4. **Baseline, then burn down.** Each new fitness rule ships with a recorded baseline of today's violations
   (`.dependency-cruiser-known-violations.json`, `eslint` suppressions file). CI fails only on **new** violations;
   each phase's exit criteria shrink the baseline.
5. **Docs move with code.** `ARCHITECTURE.md`, `AGENTS.md`, the module's `README.md` and `docs/architecture.md` are
   updated in the PR that changes the structure they describe.

---

## A0. Guardrails and baseline (no source changes)

**Goal:** every later rule is enforced on merge. Today nothing is (no CI).

**Tests first**

- `tests/architecture/fitness.test.ts` (new, runs under `pnpm test`): plants a temporary file in a fixture tree that
  breaks each dependency rule (domain → `drizzle-orm`, app → repository, a cycle) and asserts dependency-cruiser
  reports it. This proves the tool scans modules at all (the reference warns that without TypeScript installed it
  "can scan 0 modules and pass silently"); the test also asserts the cruise covered more than 300 modules.
- `tests/architecture/server-only.test.ts`: lists every file under `src/server`, `src/db` and the server-side
  `src/lib` files, and asserts each imports `server-only`. Ships with today's ~120 files in an allow-list (the
  baseline) and fails if a **new** file is missing it.
- `tests/architecture/actions-are-guarded.test.ts`: parses every `"use server"` file and asserts each exported
  function body calls the pipeline (`runFormAction`, `runStateAction`, `runActionThenGo`, `adminAction*`) or is on a
  two-entry allow-list (`approveFromEmailAction`, `runSetupAction`) that names the token the service checks.
- `tests/architecture/routes-are-guarded.test.ts`: the same for `route.ts`, with the public routes (`logo`,
  `favicon.svg`, `health`, `openapi.json`, `api/auth`) allow-listed.

**Steps**

0. Change `pnpm test` to `tsx … --test "tests/unit/**/*.test.ts" "tests/architecture/**/*.test.ts"` so the new
   architecture tests run with the unit suite (and in CI) without dropping any unit test.
1. Add devDependencies `dependency-cruiser` and `madge`; commit `.dependency-cruiser.cjs`
   ([draft](04-fitness-functions.md#draft-dependency-cruiser-config)) with `no-circular: error` and a recorded baseline
   of the 5 cycles and the one accepted Better Auth mount-route edge.
2. Add `pnpm arch` (`depcruise src --config --ignore-known`) and `pnpm arch:baseline`.
3. Add ESLint size rules as **warnings** with today's offenders suppressed: `max-lines` 100 for `actions.ts` /
   `route.ts`, `max-lines-per-function` 50 for `src/server/**`, `src/domain/**`, actions and routes, `max-lines` 500
   for use-case files. `.tsx` components get `max-lines-per-function` 150 (markup is long by nature; logic is not).
4. Add `.github/workflows/ci.yml`: install → `typecheck` → `lint` → `arch` (cycles enforced here, through the
   dependency-cruiser baseline; `madge` joins CI in A1, once it can report 0) → `test` → `test:integration:embedded` →
   `test:integration` against a Postgres 16 service → `build` (dummy secrets, as in the repo memory notes). Required
   on `main`.
5. Add `ARCHITECTURE.md`, the AGENTS.md "Architecture standard" section and ADRs 0001–0012 (this PR).
6. Record the DORA baseline in `docs/architecture-plan/dora-baseline.md`, from GitHub and Vercel history for the
   90 days before A0 merges: deployments to production per week (Vercel `ooohm` production deployments), median
   lead time from a PR's first commit to its merge (merged PRs on `main`), change-failure rate (production
   deployments followed within 7 days by a revert, rollback or a PR titled or labelled as a fix for it), and time to
   restore (from that deployment to the fix's merge). The same queries are re-run at the end of A3 and A8.

**Exit criteria**

- CI runs on every PR and is required for merge; all jobs green on `main`.
- `pnpm arch` passes with the baseline and fails on a planted violation (the fitness test proves it).
- ADR-0001 … 0012 accepted or amended by the owner.
- `dora-baseline.md` committed with the four numbers and the queries that produced them.

**Fitness functions added:** dependency-cruiser (all rules, baseline), `no-circular: error`, server-only check,
guarded-actions and guarded-routes checks, size-limit warnings.

---

## A1. Shared kernel, Result type, cycles

**Goal:** the cross-cutting pieces every module will lean on exist, and the graph is acyclic.

**Tests first**

- `tests/unit/result.test.ts`: `ok`, `err`, `isOk`, `map`, `fromDomainError` (a thrown `DomainError` becomes
  `err({ code, message, details })`; anything else rethrows).
- `tests/unit/action-pipeline.test.ts` (extend): a `work` that **returns** `err({ code: "insufficient_balance", … })`
  produces exactly the same `FormState` as one that **throws** the same `DomainError` today. Same for
  `runStateAction` and `runActionThenGo`, and for the API handler's status mapping (`not_found` → 404, …).
- `tests/unit/ids.test.ts`: branded `CompanyId`, `UserId`, `LeaveRequestId` parse from strings (`parseUserId`) and
  reject non-UUIDs; a type-level test (`// @ts-expect-error`) that a `UserId` is not assignable to a `CompanyId`.
- `tests/unit/id-generator.test.ts`: `ctx.ids.next()` is used by the fake context; a sequence generator for tests.
- Fitness: remove the 5 cycles from the baseline, so `pnpm arch` is red until they are fixed.

**Steps**

1. `src/shared/lib/result.ts`: `ServiceResult<T> = { ok: true; value: T } | { ok: false; error: AppError }`, where
   `AppError` is `{ code: DomainErrorCode; message: string; details?: … }` (ADR-0003).
2. Teach the action pipeline and the API handler to accept either a returned `ServiceResult` or a thrown
   `DomainError` (both map through the existing `messageForError`). This is what lets modules migrate one by one.
3. Break the cycles: move `DeletionBlockers` (and every error-detail type) into `domain/error-details.ts` with no
   imports; split `integrations/adapter.ts` into `adapter.ts` (the port) and `registry.ts` (imports `installed.ts`);
   merge `email-approval` into the approvals module boundary (cycle 5 disappears when `approvals` and
   `approval-routing` both live in `modules/approvals`).
4. Add `ids: IdGenerator` to `ServiceContext`; replace the 7 `randomUUID()` call sites in services.
5. Branded IDs in `src/shared/kernel/ids.ts`, adopted at the edges first (`toActor`, route params, zod schemas with
   `.brand()`), then inward module by module.
6. Add `--conditions=react-server` to every script invocation that lacks it (`db:migrate`, `db:seed`, and both
   commands in `vercel-build`), and prove it with a test that runs `scripts/seed.mts --if-production` against PGlite.
   Only then add `import "server-only"` to every server file (mechanical; shrink the A0 allow-list to zero).
7. Add `pnpm madge` (`madge --circular --extensions ts,tsx src`) to CI now that it reports 0.

**Exit criteria**

- `madge --circular src` reports 0; `no-circular` baseline is empty.
- server-only allow-list is empty.
- The pipeline accepts Results; at least one existing action (pilot: `renameSelf` on `/account`) returns a Result.
- All existing suites green on both drivers.

**Fitness functions added:** server-only (now strict), `no-circular` (strict).

---

## A2. Module skeleton and two pilot modules (Tier 2)

**Goal:** prove the module template on low-risk code before touching leave or balances.

Pilots: **reports** (a pure query module: read model, DTOs, no writes) and **organisation/levels** (smallest CRUD:
`admin-levels.ts`, `repositories/levels.ts`, `app/admin/levels`).

**Tests first**

- Fitness (red): new dependency-cruiser rules `no-deep-import-from-outside` + `no-deep-import-across-modules` (anything outside `src/modules/<m>/` may import
  only `@/modules/<m>`, i.e. its `index.ts`) and `module-layers` (`ui` → `application`; `application` →
  `domain`; `infrastructure` → `application` | `domain`; `domain` → nothing outside it; `application` may not import
  `infrastructure` **except** through the composition root in Tier 3, and directly in Tier 2 for repositories).
- `tests/unit/modules/reports/report-dto.test.ts`: `toLeaveReportDTO(report)` returns only the fields the page shows
  (pinned with a snapshot).
- `tests/unit/modules/organisation/levels-policy.test.ts`: `canManageLevels(actor)`.
- Keep `tests/integration/reports.test.ts` and the levels assertions in `allowance-rules.test.ts` unchanged; they
  must pass through `@/modules/reports` and `@/modules/organisation` after the move.

**Steps**

1. Create `src/modules/reports/{ui,application/queries,infrastructure,index.ts,README.md}`. Move
   `services/reports.ts` → `application/queries/get-leave-report.ts`, `repositories/reports.ts` →
   `infrastructure/drizzle-reports.repository.ts`, `domain/reports.ts` → `domain/` (it has real computation),
   `app/_lib/report-input.ts` → `application/schemas.ts`, and the formatting in `app/reports/page.tsx`
   (372 lines) into `ui/report-presenter.ts`. The page drops under 150 lines.
2. Same for levels in `src/modules/organisation/`.
3. Document the template in `src/modules/README.md` and ADR-0009.

**Exit criteria**

- `src/app/reports/page.tsx` ≤ 150 lines; it imports only `@/modules/reports` and `@/shared/*`.
- Both pilot modules have a README stating their public API; nothing imports their internals.
- `no-deep-import-*` and `module-layers` are errors with an empty baseline for `src/modules/**`.

---

## A3. Tier 3: leave

**Goal:** the leave request is an aggregate whose rules live in one place and are tested without a database.

**Tests first** (all against in-memory fakes, no database)

- Domain (`tests/unit/modules/leave/`):
  - `date-range.test.ts`: `DateRange.create(start, end)` refuses end before start (`invalid_date_range`), over 366 days (`range_too_long`), non-dates;
    value equality.
  - `day-count.test.ts`: `DayCount` is non-negative with one decimal; `0.5` only for a single-date half day (`half_day_multi_day`);
    weekends and company holidays never count (moves today's `leave-days` cases here, unchanged).
  - `leave-request.aggregate.test.ts`: `LeaveRequest.submit(...)` → `pending` or `approved` (self-approval) and
    records `LeaveRequested` (+ `LeaveApproved`); `cancel()` from pending/approved records `LeaveCancelled`;
    `cancel()` of an approved past-year request returns `err("past_year_closed")`; illegal transitions return
    `err("invalid_transition")`; overlaps with an active request return `err("overlapping_request")`.
- Application (`tests/unit/modules/leave/use-cases/`), with `InMemoryLeaveRequestRepository`,
  `InMemoryAllowanceReader`, `FixedClock`, `SequenceIds`, `RecordingOutbox`, `RecordingAudit`:
  - `submit-leave-request.test.ts`: returns `ok(LeaveRequestDTO)`; writes one audit row and one `leave.requested`
    event (two when self-approved) in one unit of work; refuses the 11th request in 10 minutes (`rate_limited`);
    `insufficient_balance` carries year, requested and remaining days; heads-up flag when coverage is exceeded.
  - `cancel-leave-request.test.ts`, `add-leave-for.test.ts`, `remove-leave-for.test.ts`, `recount-leave.test.ts`.
- Contract: `tests/unit/modules/leave/events.contract.test.ts` pins every `leave.*` payload field (add, never rename
  or remove, per `docs/api.md`).
- Infrastructure: `tests/integration/modules/leave/drizzle-leave-request.repository.test.ts` runs the **same**
  repository contract suite against the Drizzle implementation that the fake passes (one shared
  `leaveRequestRepositoryContract(make)`), on Postgres and PGlite. This is what keeps the fake honest.

**Steps**

1. `domain/`: `DateRange`, `DayCount`, `LeaveRequest` (pure functions over a readonly type, returning `Result`;
   ADR-0003 prefers functions to classes), `LeaveStatus` machine (from `request-status.ts`), events, errors.
2. `application/ports.ts`: `LeaveRequestRepository` (intention-revealing: `lockRequester`, `findActiveOverlapping`,
   `countRecentByRequester`, `insert`, `updateStatusIfCurrent`), `AllowanceReader` (balances' public API),
   `ApprovalRouter` (approvals' public API).
3. Split `submitLeaveRequest` (110 lines) into the use case (load → `LeaveRequest.submit` → save → record → notify),
   each step ≤ 50 lines. Same for `getDashboard` (83) as a query.
4. `infrastructure/drizzle-leave-request.repository.ts` implements the port with today's queries and a mapper
   (row → `LeaveRequest`); `LeaveRequestRow` stops leaving the module.
5. Wire in `server/runtime.ts`: `leaveModule(ctx)` returns the use cases with their concrete ports.
6. Actions in `src/app/actions.ts`, `requests/**`, `team/**` call `@/modules/leave` and get Results.

**Exit criteria**

- Every leave use case has a fake-backed test; the domain rules from `leave-request`, `request-status`, `overlap`,
  `leave-days`, `coverage` live in `modules/leave/domain` with their old tests passing unchanged.
- Integration tests `leave-requests`, `leave-on-behalf`, `heads-up`, `holiday-recount`, `coverage` unchanged and
  green on both drivers.
- No exported `Row` type from the module; all functions ≤ 50 lines; every use case returns `ServiceResult`.

## A4. Tier 3: approvals

**Tests first:** `approver-for.test.ts` (manager → department manager → oldest other admin; self-approve), the
reassignment cases (approver deactivated, demoted, manager changed, new admin can take an admin-routed request),
`decide-leave-request.test.ts` on fakes (approve/reject only by the assigned approver or an admin; reject needs no
reason, approve from email needs a valid unexpired signed token and the approver still assigned), and a repository
contract suite for `ApprovalContextReader`.

**Steps:** move `approvals`, `approval-routing`, `email-approval` into `modules/approvals`; `ManagerApprovalRule`
becomes `domain/approver-for.ts`; `loadApprovalContext` stays the one routing loader (AGENTS.md rule) as the
module's port implementation. Leave depends on `ApprovalRouter` (a port leave owns, approvals implements), so
approvals → leave is the only direction (no cycle).

**Exit:** cycle 5 gone for good; approvals integration tests (`approvals`, `department-managers`,
`email-approval`) unchanged and green.

## A5. Tier 3: balances

**Tests first:** `allowance-default.test.ts` (most specific rule wins: department + level > level > department >
type default), `balance.test.ts` (available = days + carried + adjustment − used, one decimal),
`rollover.test.ts` on fakes (idempotent: running twice changes nothing; carryover off by default; capped by
`carryoverMaxDays`), `edit-allowance.test.ts` (audit row with the admin's reason, `balance.adjusted` without it), a
strategy test that `annual_calendar_year` is resolved through an `AllowancePolicy` registry (pluggable, per AGENTS.md),
and a repository contract suite.

**Steps:** `AllowancePolicy` as a Strategy in `domain/`; `loadAllowanceDefaults` becomes the module's single read
path (AGENTS.md rule kept, now enforced by the module boundary: `leaveType.defaultAllowanceDays` is not exported);
`rollover` becomes `application/use-cases/roll-over-year.ts` (68-line `rollMember` split).

**Exit:** `balances`, `allowance-rules`, `admin-allowances`, `rollover` integration tests unchanged and green;
`pnpm job:rollover` idempotency test green.

---

## A6. Remaining Tier 2 modules

One PR per module, in this order (least coupled first): **holidays**, **calendar**, **organisation** (rest),
**notifications**, **audit**, **people**, **integrations**, **import**, then `server/jobs` and `server/identity`.

For each module, **tests first**:

- A policy unit test per authorization rule that moved (`canSeeOnCalendar`, `canAdminister`, …).
- A DTO test pinning what leaves the module (no `Row` types; for people, no email unless the screen shows it).
- For integrations: **contract tests** for every event envelope and webhook payload in `docs/api.md` (zod schemas in
  `modules/integrations/application/contracts.ts`, recorded sample payloads in `tests/contracts/*.json`), and the
  signature verification vectors.
- For people: split `admin-people.ts` (577) and `admin-people-deletion.ts` (678) one use case per file; the
  deletion lifecycle (schedule → grace → scrub) gets a domain test for every transition before the split.
- For import: split `runImport` (458 lines) into plan → apply steps, each with a unit test on the mapped records;
  `buildImportPlan` (507) split per entity.

**Exit criteria (whole phase):** `src/server/services` and `src/server/repositories` are empty and deleted; every
module has a README; service-to-service edges (101 today) are 0; cross-module edges go only through `index.ts`.

---

## A7. Presentation: thin controllers, presenters, DTOs, component tests

**Tests first**

- Component tests (React Testing Library on `node:test` with `global-jsdom`, ADR-0007) for the interactive
  pieces where a bug costs most: `request-leave-form` (preview fetch, half-day rules), `decision-form` /
  `approval-item` (decide, collapse, focus moves), `date-picker` (already has logic tests), `cancel-request` (undo),
  `delete-person-dialog`, `email-editor` (variables, preview).
- Taint test: `experimental_taintObjectReference` on user rows loaded in `server/identity`; a test page that passes
  one to a client component fails to render.
- Fitness (red): `max-lines` 100 on `actions.ts` / `route.ts` and `max-lines-per-function` 50 become **errors**;
  `actions.ts` may import only `@/modules/*`, `@/app/_lib/*`, `zod` (no `@/shared/kernel` rules, no domain).

**Steps**

1. Split `admin/people/actions.ts` (185) and `admin/webhooks/actions.ts` (124) into one file per action group.
2. Move page-side formatting into `modules/<f>/ui/*-presenter.ts` for the six pages over 150 lines.
3. The leave preview's `fetch` moves into a `useLeavePreview` hook in `modules/leave/ui` (the only client data
   fetch; no TanStack Query, ADR-0008).
4. Per-person rate limit on server actions in the pipeline (cross-cutting), reusing `src/lib/rate-limit.ts`.

**Exit:** no action/route file over 100 lines, no function over 50 outside `.tsx`; every module's `index.ts`
exports only use cases, queries, DTO types and policies (ADR-0009), never a row type or anything from
`infrastructure/` (F11); component tests run in CI.

---

## A8. Data security, strictness, end-to-end, burn-down to zero

**Tests first**

- **Tenant isolation** (`tests/integration/tenancy.test.ts`): two companies; for every repository function that takes
  a `companyId`, calling it with company B's id never returns or changes company A's rows. Generated from a list of
  repository exports so a new repository function without a case fails the test.
- If ADR-0004's RLS option is accepted: `tests/integration/rls.test.ts` connects as the app role, sets
  `app.company_id` to A, and asserts `SELECT`/`UPDATE`/`DELETE` on every company-scoped table cannot see B; and that a
  connection without `app.company_id` sees nothing. Runs on Postgres and PGlite.
- Migration drift (`tests/integration/migrations.test.ts`, extend): `drizzle-kit generate` against `schema.ts` produces
  no new migration. This checks schema files against committed migrations only (ADR-0011); live-database drift is a
  separate scheduled `pg_dump --schema-only` comparison against Neon.
- Playwright journeys (`tests/e2e/*.spec.ts`), one per role, on `pnpm start:embedded`: employee requests and cancels
  leave; manager approves from the inbox and from the email link (Mailpit); admin invites a person, edits an allowance,
  adds a holiday; plus a tenant-isolation journey (an id from another company is a 404).

**Steps**

1. Database roles (ADR-0006): `ooohm_owner` for migrations, seed and import (`src/server/admin/db.ts`);
   `ooohm_app` (no DDL, no `audit_log` UPDATE/DELETE) for requests, the cron route and the worker. Every Postgres
   deployment (Neon, docker-compose) must set `DATABASE_ADMIN_URL`; docker-compose creates both roles in its init step.
   Embedded PGlite is the one exception and keeps a single handle (ADR-0006).
2. RLS as defence in depth, if accepted (ADR-0004): enable on every company-scoped table with explicit per-operation
   policies on `current_setting('app.company_id', true)`, set with `set_config(..., true)` at the start of
   `inTransaction` (transaction-scoped, so it is safe behind Neon's PgBouncer pooler).
3. Turn on `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` for `src` (a `tsconfig.src.json` used by
   `typecheck`), then for tests.
4. Empty every baseline: dependency-cruiser known violations, ESLint suppressions, server-only allow-list.

**Exit criteria = full compliance**

- All fitness functions are errors with **empty baselines**.
- Tenant-isolation, RLS (if adopted), drift and e2e suites run in CI and are required.
- `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` across `src`.
- The two-role split holds on every Postgres deployment; PGlite is the recorded exception (ADR-0004, ADR-0006).
- Every module: README, `index.ts` exporting only use cases, queries, DTO types and policies, use cases returning `ServiceResult`, tests per its tier.
- DORA baseline recorded (A0) and re-measured: lead time not worse, change-failure rate not worse. If layering slows
  lead time without lowering failures, simplify (reference §28).

**Status.** Done: the strict flags for the whole repository, tests and scripts included (`tsconfig.json`, run by
`pnpm typecheck`); empty baselines (no
dependency-cruiser known violations, no server-only allow-list; the one ESLint size exception is
`src/components/ui/sortable-list.tsx`, with its reason); `src/domain` emptied into `src/shared/kernel` and module
`domain/` folders; the tenant-isolation, drift and e2e suites in CI; the two database roles. Still open: the RLS decision (ADR-0004, still Proposed) and the DORA re-measure.

---

## Sequencing and size

| Phase | PRs | Depends on | Risk |
| --- | ---: | --- | --- |
| A0 Guardrails | 2 (CI + fitness; docs = this PR) | — | Low |
| A1 Kernel, Result, cycles | 3 | A0 | Low |
| A2 Pilots | 2 | A1 | Low |
| A3 Leave (Tier 3) | 3 (domain, use cases, wiring) | A2 | **High**: most-used flow |
| A4 Approvals (Tier 3) | 2 | A3 | Medium |
| A5 Balances (Tier 3) | 2 | A3 | Medium |
| A6 Tier 2 modules | ~10 (one per module) | A2; integrations after A3 | Low–medium each |
| A7 Presentation | 3 | A6 | Low |
| A8 Security, strictness, e2e | 4 | A6 (RLS needs repositories in modules) | Medium |

A4 and A5 can run in parallel after A3. A6 modules that don't touch leave (holidays, organisation, notifications,
audit) can start right after A2.

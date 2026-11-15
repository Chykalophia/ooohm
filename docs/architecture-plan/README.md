# Architecture overhaul plan

This is the plan for bringing OOOhm into line with Chykalophia's *SaaS Layered Architecture Reference*
(Nov 14, 2026). It changes no code. Each phase ships separately and keeps the app's behaviour the same.

| Doc | What it covers |
| --- | --- |
| [01-audit.md](01-audit.md) | The app as it is: module map, dependency-rule violations, fat actions and use cases, rows reaching the client, where auth runs, missing `server-only`, cycles, test coverage per layer, types, database, CI |
| [02-target-modules-and-tiers.md](02-target-modules-and-tiers.md) | The target tree, the tier for each module, and where every existing file goes |
| [03-phased-plan.md](03-phased-plan.md) | Phases A0–A8. For each one: the tests written first, the steps, the exit criteria and the fitness functions it adds |
| [04-fitness-functions.md](04-fitness-functions.md) | The CI checks, the draft dependency-cruiser config, the measured baseline and how to measure it again |
| [../adr/](../adr/) | ADR seeds 0001–0012 (all Proposed). These include the equivalents on this stack for the reference's Supabase-specific rules |

## The audit in one paragraph

OOOhm is already layered and the layers hold. It has no layer-skipping imports, no vendor SDK outside
infrastructure, and auth runs in every action and in the services. What it is missing is the standard's **shape**:
feature modules with public APIs (today 46 services sit in one folder and import each other 101 times),
`ServiceResult` instead of thrown errors, DTOs instead of Drizzle rows at the service boundary, `server-only` in
server files (11 of about 130 have it), five import cycles, in-memory fakes, component tests and e2e journeys, and
**any CI at all**. Phase A0 adds CI first, so every later rule is enforced when a PR merges.

## Tiers

Tier 3 applies to **leave**, **approvals** and **balances**, because those are the modules with real invariants.
Every other module is Tier 2. Calendar, holidays and people also get a `domain/` folder, because they already
have pure rules.

## Supabase rules on this stack

| Reference rule (Supabase) | OOOhm equivalent | ADR |
| --- | --- | --- |
| RLS on every exposed table, tested with pgTAP | A generated tenant-isolation suite over every repository function. RLS on `app.company_id` is recommended as defence in depth, to be decided at A8, and tested with SQL assertions (PGlite has no pgTAP) | 0004 |
| Service-role client only in `src/server/admin/` | A separate owner database role and URL, opened only from `src/server/admin/db.ts`, used by migrations, seed and import. The app role is DML-only and cannot rewrite `audit_log` | 0006 |
| `getClaims()`/`getUser()`, never `getSession()` | Better Auth `getSession()` with the cookie cache **off**, which reads the session table on every request. A test pins that setting | 0005 |
| `supabase db diff` in CI, migrations only | drizzle-kit drift check in CI. No business logic in the database | 0011 |
| Generated Supabase types only in `infrastructure/` | Drizzle `$inferSelect` row types never leave a module's `infrastructure/` (fitness check F11) | 0009 |
| `@supabase/*` only in infrastructure | `drizzle-orm`, `postgres`, PGlite, `better-auth` and `nodemailer` only in infrastructure (F3) | 0005, 0009 |

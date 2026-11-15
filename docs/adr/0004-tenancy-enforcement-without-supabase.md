# ADR-0004: Tenancy enforcement on Postgres + Drizzle (in place of Supabase RLS)

- **Status:** Accepted
- **Date:** 2026-11-15

## Context

The reference's Supabase rules require RLS on every exposed table, tested with pgTAP, because Supabase exposes the
database to the browser through PostgREST. OOOhm runs on Neon Postgres (or any Postgres 15+, or embedded PGlite)
through Drizzle, from server code only. No browser, anon key or PostgREST endpoint can reach the database. Tenancy
before this decision: `company_id` always came from the actor, every repository query was scoped by it, and a
foreign id read as `not_found`. pgTAP is not available on PGlite.

## Decision

1. **A tenant-isolation integration suite** (`tests/integration/tenancy.test.ts`) calls every exported module, job
   and identity function with a second company's ids and asserts it can neither read nor change the first company's
   rows. It runs on Postgres and PGlite and fails when a new function has no case.
2. **Two database roles** (ADR-0006): the request-path role has no DDL, no `BYPASSRLS`, and cannot `UPDATE` or
   `DELETE` `audit_log`.
3. **Row-level security, enforced**, as the second net for a forgotten `where company_id = …`. The design follows.

### The policies (`drizzle/0031_row_level_security.sql`)

Every tenant table has `ENABLE` and `FORCE ROW LEVEL SECURITY` and five permissive policies:

- `<table>_tenant_select`, `_insert`, `_update`, `_delete`, `TO PUBLIC`, on `public.ooohm_tenant()`: an inlinable
  `STABLE` SQL function, `nullif(current_setting('app.company_id', true), '')::uuid`. A missing or empty setting is
  `NULL`, which matches no row: **no tenant sees nothing and writes nothing.** `UPDATE` has both `USING` and
  `WITH CHECK`, so a row can be neither reached nor moved into another company.
- `<table>_owner`, `FOR ALL TO <owner> USING (true) WITH CHECK (true)`. `FORCE` holds the owner to policies too;
  this one lets it, and only it, through: migrations, the seed, the TimeOff import, foreign-key cascades and the
  `SECURITY DEFINER` functions below. Migrations create it `TO CURRENT_USER`; `deploy/db-roles.sql` re-points it at
  the owner role when a single-role install is split.

| Table | Scoped by |
| --- | --- |
| `companies` | `id` |
| `departments`, `levels`, `email_templates`, `leave_types`, `allowance_rules`, `holidays`, `user`, `leave_requests`, `audit_log`, `events_outbox`, `webhook_endpoints`, `webhook_deliveries`, `adapter_deliveries`, `api_keys`, `import_runs` | their own `company_id` |
| `calendar_feed_tokens` | `company_id`, or a link whose person is the tenant's member (see below) |
| `allowances` | its person's company; inserted and updated rows' leave type must be the tenant's too |
| `leave_request_days` | its request's company |
| `session`, `account`, `passkey` | their person's company |
| `installation`, `scheduled_jobs`, `verification` | none: deployment-wide, no company's data (`verification` holds sign-in tokens before anyone is known) |

`tests/architecture/row-level-security.test.ts` fails when a table with `company_id` (or one listed as scoped through
its parent) lacks the four policies with `ooohm_tenant()`, when a migration disables or drops them or grants
`BYPASSRLS`, and when a `SECURITY DEFINER` function appears that is not listed there. `tests/integration/rls.test.ts`
asserts, in SQL as the app role on both drivers, for every tenant table: a tenant sees exactly its own rows; it
cannot read, update, delete, insert into or move rows into another company; no setting and an empty one see and
write nothing; the owner sees every company; the catalog matches the list above; and the app role is neither a
superuser nor exempt.

`calendar_feed_tokens` is the one table with a second branch: a person's own links from a company they have left stay
visible to their new company, so they can see and turn off a link that would work again if they moved back
(`listCalendarFeeds`). Its `UPDATE ... WITH CHECK` lets such a row only be revoked, and a trigger
(`calendar_feed_tokens_company_fixed`) keeps every link in the company it was issued in, so none can be moved into
the new company, which would revive it. The revoke is recorded in the
link's company: `recordFeedChange` switches the transaction's tenant for that one audit row and event
(`switchTenantWithin`, `src/db/tenant.ts`, which the fitness test allows only there).

### Setting the tenant

`set_config('app.company_id', <id>, true)`: transaction-local, so safe behind Neon's PgBouncer pooler, and it never
outlives the transaction. It is set below Drizzle (`src/db/tenant.ts`), by the database handle itself, so it never
appears in a query log or a query count:

- `tenantDatabase(db, companyId)` returns a handle bound to the company (one per company per pool, cached). Every
  transaction it opens sends the `set_config` pipelined with its first statement. A statement outside a transaction
  is sent as `begin; set_config; statement; commit` on one reserved connection, in one flight. On PGlite, a
  transaction wraps each statement.
- Services reach it through `forTenant(ctx, companyId)` (`src/shared/lib/tenant.ts`), with the company of the actor or
  the API key, never one from input. `inTransaction`, `commitThen` and `commitThenNotify` now take the company and
  scope themselves; the Tier 3 compositions bind their read ports to the actor's company and gain `tenant(companyId)`
  for flows that find the company first (the email link, the rollover). A context already scoped to another company
  throws. `forTenant` binds on first use, so a call refused on its input touches nothing.
- An unscoped `ctx.db` (the app role with no tenant) sees no tenant rows: only the tables without a tenant and the
  pre-tenant functions work there.

### Paths that run before a tenant is known

These use narrow `SECURITY DEFINER` functions owned by the owner, each `STABLE`, with `search_path` pinned to
`pg_catalog, public`, `EXECUTE` revoked from `PUBLIC` and granted to the app role, keyed by a secret or returning only
what the caller needs. They are called from `src/shared/lib/db/pre-tenant.ts` only; what the caller does next runs
for the company found, through `forTenant`.

| Function | Path | Returns |
| --- | --- | --- |
| `ooohm_api_key_for_hash(hash)` | REST API authentication | the live key's id, company, hash, scopes, last use |
| `ooohm_calendar_feed_for_hash(hash)` | ICS feeds | the live feed of an active owner, with what rendering it needs |
| `ooohm_link_person(user_id)` | approve from the email (the id is inside a signed link) | the person's id, company, role, self-approval and active flag |
| `ooohm_deployment_brand()` | sign-in page, favicon, root layout | the oldest company's name, look and logo description |
| `ooohm_logo_file(sha256)` | public logo files | the bytes and type of the logo with that hash |
| `ooohm_companies()` | the year rollover, retention | every company's id, time zone, working days and policy |
| `ooohm_undispatched_event_companies(limit)` | outbox dispatch | which companies hold the oldest `limit` events, and how many each |
| `ooohm_due_webhook_companies(now, limit)` | webhook delivery | which companies hold the first `limit` due deliveries, and how many each |
| `ooohm_due_adapter_companies(now, limit)` | adapter delivery | the same for adapter deliveries |
| `ooohm_due_scrubs(now, limit, cursor)` | scheduled scrubs | due people's ids, companies and due times |
| `ooohm_emails_in_use(emails[])` | invite, people import, inbound sync | which of those addresses an account uses, and its company |
| `ooohm_is_populated()` | first install | whether any company or person exists |

The two audit functions from `drizzle/0030` (`ooohm_erase_audit_about`, `ooohm_redact_audit_snapshots`) now also
require `company_id = ooohm_tenant()`, so they act only inside the caller's tenant.

- **Sign-in and Better Auth** run before any company is known. Better Auth reads `user`, `session`, `account` and
  `passkey` through four owner-owned `security_barrier` views of them (`auth_user`, …, mapped in
  `src/db/auth-schema.ts`, which only `src/lib/auth.ts` imports). A view runs as its owner, so it reads past the
  policies; this is how the existing behaviour (invite-only, the deactivation hook) keeps working, and the fitness
  test keeps the views out of every other file. `verification` has no tenant.
- **Jobs** loop over companies: dispatch and delivery ask the definer functions which companies hold the next batch
  and how many items each, then claim each share in a transaction for that company (`FOR UPDATE SKIP LOCKED` as
  before), so the batch size and the concurrency guarantees hold. Retention and the rollover loop over
  `ooohm_companies()`. `scheduled_jobs` has no tenant, so the job claims are unchanged.
- **First install** chooses the company id before the transaction and runs in it.
- **Seed, migrate and the TimeOff import** connect as the owner, which its policy lets through. There is no
  app-settable bypass: no setting turns the policies off, and no role but the owner gets past them.

**No separate worker role.** The worker, the cron route and `pnpm job:rollover` run as the app role and reach other
companies only through the definer functions above, which return queue shares and ids, never rows. A third role
would add another credential to deploy and rotate and would read every company anyway.

### Embedded PGlite

PGlite's only user is a superuser, which bypasses row security. The app's handle therefore runs every statement and
transaction as the `NOLOGIN` role `ooohm_app` (`set_config('role', 'ooohm_app', true)`, `embeddedRoleClient`), which
`prepareEmbeddedAppRole` creates and grants after each embedded migration. The policies hold there exactly as on
Postgres (the RLS suite runs on both drivers). PGlite lets a superuser connection switch back, so on PGlite this
guards against a forgotten tenant, not against code that switches role on purpose.

### Overhead

Measured with a script that reads one `companies` row over a TCP proxy adding a fixed delay each way, as the app
role, on Postgres 16 (median of 100 to 300 runs, ms):

| Added round trip | Bare statement | Tenant statement | Bare transaction (1 stmt) | Tenant transaction (1 stmt) | Bare transaction (3) | Tenant transaction (3) |
| --- | --- | --- | --- | --- | --- | --- |
| 2 ms | 5.3 | 7.8 | 10.1 | 12.7 | 20.5 | 23.2 |
| 10 ms | 21.8 | 32.7 | 43.2 | 54.0 | 86.0 | 97.2 |

So the tenant costs about one round trip per standalone statement and one per transaction, whatever the number of
statements in it, and nothing per row: the policies are index-friendly equality checks (`company_id = <constant>`,
or an `EXISTS` on the parent's primary key).

## Consequences

- A repository query that forgets `company_id` returns nothing and writes nothing, instead of another company's
  rows. The tenant-isolation suite still catches it; RLS makes it harmless if it slips through.
- A new table with `company_id` needs its policies in the same migration (the fitness test says so). A new pre-tenant
  path needs a narrow definer function, listed in the fitness test with why.
- Reads of tenant rows go through `forTenant(ctx, companyId)` (or a Tier 3 composition, or `inTransaction` /
  `commitThenNotify`, which scope themselves); a read on a bare `ctx.db` sees no tenant rows.
- About one round trip more per request statement or transaction.
- Installs still on one role (the app connecting as the owner) keep working, unprotected by the policies until they
  split their roles (docs/deploy.md#database-roles).
- The two-role split applies to every Postgres deployment. Embedded PGlite keeps one data directory and one
  superuser, with the app's handle acting as `ooohm_app` as described above.

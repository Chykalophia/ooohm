# OOOhm architecture

OOOhm is one Next.js app (App Router) over one Postgres database. The code is layered so that the rules
that matter (who approves what, how days are counted, which status changes are legal) live in plain
TypeScript that can be tested without a browser, a server or a database.

## Layers

Dependencies point downward only. A layer never imports from one above it. `pnpm lint` enforces this table
with per-directory `no-restricted-imports` rules in `eslint.config.mjs`; change both together. Those rules match
import specifiers, so imports across directories use the `@/` alias and a parent-relative (`../`) import is a
lint error everywhere under `src/`. `src/server/notifications/templates/**` (email templates) and `src/server/context.ts` (the
`ServiceContext` type) sit just below services: no Next.js, database, schema, Drizzle, `env`, `auth`, services or
repositories. The rest of `src/server/notifications` (the catalog of email types and the after-commit sender) sits
beside services: it may read through repositories (the company accent) but never calls a service. `src/server/integrations/**` (the adapter seam, M6) and `src/server/importers/**` (source readers for
one-time imports, M7: they read another system's files into domain records and never touch OOOhm's database)
follow the same rules. `src/server/runtime.ts` is the composition root and imports no service or repository.
`scripts/*.mts` (migrate, seed, rollover, the outbox worker, the TimeOff import) are composition roots for
processes outside Next: the rollover, the worker and the TimeOff import build their `ServiceContext` with
`scriptContext` (`scripts/script-context.mts`).

| Layer | Path | Owns | May import |
| --- | --- | --- | --- |
| Presentation | `src/app/**` | Pages, layouts, route-specific components, server actions, route handlers | services, `@/server/runtime`, shared UI, domain types, constants and pure functions, `lib` |
| Shared UI | `src/components/**` | Reusable components and class recipes that render what a page passes in | domain types and pure functions, `lib` (not `env`, `db`, `auth`); never `src/app` or `src/server` |
| Application (services) | `src/server/services/**` | Use cases, transactions, data-dependent authorization, audit + outbox writes, post-commit email | repositories, domain, `@/server/context`, `@/server/notifications`, `lib` (not `env`, `db`, `auth`) |
| Data access (repositories) | `src/server/repositories/**` | Drizzle queries only. Every function takes an executor (`db` or `tx`) first | `@/db/schema`, `@/db/types`, domain types |
| Domain | `src/domain/**` | Pure types, rules and policies. No I/O, no Next.js, no Drizzle, no env | nothing outside `src/domain` |
| Infrastructure | `src/lib/**`, `src/db/**` | Env, logging, mail transport, auth, formatting, schema, the connection pool | `domain` (pure functions and types, e.g. `toActor` for `requireActor`) |

Rules of thumb:

- **Pages and actions are thin.** A page calls its loader, one or two service functions, and renders shared
  components; an action is a zod schema and one service call. No Drizzle in `src/app`. See
  [Presentation](#presentation).
- **Services own the transaction.** A service opens `db.transaction`, re-reads what it needs inside it, checks
  permissions against that data, writes, and records the change. Email is returned from the transaction
  callback and sent by `commitThenNotify` after commit, so a rolled-back change never emails anyone.
- **Repositories have no rules.** They take ids that the service already scoped to the actor's company.
- **The domain decides.** `ManagerApprovalRule`, `countLeaveDays`, the status state machine and the
  permission checks are pure functions with unit tests.

### Presentation

Every screen is built from the same pieces, so a rule about how something looks or behaves lives in one file.

**Pages** start with a loader from `src/app/_lib/page-context.ts`: `requireMemberPage()` (the session, or a
redirect to sign-in; the service context; what the header needs) or `requireAdminPage()` (the same, or a 404 for
non-admins). A person whose account has no company gets `actor: null`, and the page returns
`<NoCompany nav={page.nav} …/>`. The header's approvals count starts loading in the loader and is awaited by
the header, so it runs alongside the page's own queries. Detail pages wrap their read in `orNotFound()`, which
turns `not_found` into the 404 page. A page then renders inside `AppPage` (or `AdminShell`, which adds the admin
sub-navigation): the header, the page's one `h1` with its description and main action, then its content.

**Server actions** are a zod schema (common field schemas are in `src/app/_lib/form-fields.ts`) and one
service call, run through the pipeline in `src/app/_lib/action-pipeline.ts` (wired to Next.js in
`server-action.ts`; its order of steps is unit-tested with fakes): session, company, role (for `who: "admin"`), parse, the service call through
`runActionWith`, then `refresh()` after a success. `runFormAction` returns a calm message (`FormState`),
`runStateAction` returns an action's own state (a revealed secret, a new calendar link) and `runActionThenGo`
navigates away. The admin wrappers in `src/app/admin/admin-action.ts` are these with `who: "admin"`.

**Shared components** live in `src/components`, by kind; route-specific ones sit beside their route
(`src/app/admin/people/delete-person-dialog.tsx`):

| Folder | Holds |
| --- | --- |
| `ui/` | Primitives with no domain knowledge: class recipes (`styles.ts`), `Card`, `ItemList`/`Item`, `Section`, `PageHeader`, `BackLink`, labelled fields (`TextField`, `SelectField`, `TextAreaField`, `CheckboxField`, `Fieldset`, `ChoiceChip`), `FilterBar`, `ColorLabel`, `CopyField`, `SteadyLabel` (text that turns bold without changing width, so navigation never shifts), `DataTable` (a dense table for long records: sticky header, rows that open to their detail), `SortableList` (a list reordered by dragging a handle, with mouse, touch or keyboard, saved on drop), `TableToolbar` (its search, Filters panel and filter chips), `useFilterForm` (the behaviour of every filter form) |
| `forms/` | Forms bound to server actions: `useFormAction` (no automatic reset, so a refused submit keeps what was typed), `useConfirm` (the "ask first" step, with focus moved to the question and back), `ActionForm`, `InlineAction` (a quiet action on a record, optionally confirmed first), `Reveal`, `RevealForm` (a secret shown once), `FormStatus` and `ErrorMessage` |
| `layout/` | The page frame: `AppPage`, `AppHeader`, `AccountMenu`, `NoCompany`, the logo |
| `navigation/` | `PillNav`, `MonthNav`, `YearNav`, `Pager`, `PageSizeNav` |
| `leave/` | Leave and balance displays: `StatusBadge`, `LeaveChip`, `BalanceSummary`, `BalanceList`, `BalanceFigures`, `LeaveTypeName` |

Components render what they are given: they never load data, read the session or import from `src/app` or
`src/server` (`pnpm lint` enforces this; the one auth import allowed is `@/lib/auth-client`, the browser's
sign-in client behind Sign out). The header reads the approvals count with React's `use`, so it is an ordinary
component, not an async one. Controls take their classes from the recipes in
`src/components/ui/styles.ts` (`buttonClass(variant, size)`, `field`, `textLink`, `errorText`…) rather than
spelling out Tailwind classes again, so the one accent colour, the focus ring and the error colour stay the same
everywhere; `cx()` joins optional classes. Two classes that set the same property (`p-4` and `p-5`) must never be
combined, since which one wins depends on stylesheet order: a component offers a variant instead (`Card`'s
`padding`).

**Look: the company's theme and each person's colour mode.** An admin picks the company's theme (Admin →
Appearance, below): colours, fonts, corners, depth. Each person picks a colour mode on their account page: light
(the default), dark or automatic (follows the device). It is `user.colorMode` (the column is still named `theme`),
read with the session. The root layout writes both to `<html>` (`htmlAppearance`): `data-ui` for the theme and
`data-mode` for the mode, which sets `color-scheme`. A theme with a dark version (Classic, with its own accent) holds
each colour's two values in `light-dark()`, so the first paint is right with no script and automatic switches as
the device does; on any other theme `data-mode` is forced to light. Colours come only from tokens (`bg-surface`,
`text-muted`, `text-accent-ink`, `text-danger`…): `pnpm lint` refuses palette classes (`text-red-700`) and `dark:` in
`src/app` and `src/components`. A new colour is a new token, with a dark value in every theme that has one. The
colour mode is a display preference of the person's own, so changing it writes no audit row or event.

**Long lists.** Every list that grows with use is paged, never capped: the audit log (25 a page), people (50, by
name), "Your requests" (10, latest dates first), approvals (10, earliest first) and an endpoint's
webhook deliveries (25). Short lists that stay small by nature (departments, leave types, a year's holidays, API
keys, calendar links, webhook endpoints, which stop at 20) are not. Pages are keyset, both ways
(`src/domain/paging.ts`): a page is the `size + 1` rows just after (or, for Previous, just before) the sort key of
the row at its edge, so each page is one read however deep someone goes (Previous adds a one-row read), and no row
is skipped or shown twice because rows were added or removed in between (a row added behind the page shows on the
earlier pages). The audit log, deliveries and the inbox read their indexes in order; people and a person's requests
sort a company's (or a person's) rows, which stays small. The key travels as an opaque token in `?after=` /
`?before=`; each list checks every part (a uuid, a date, an instant, or text up to a length and without NUL) and
reads anything else as page 1. Repositories build the query with `keysetPage` (`src/server/repositories/keyset.ts`), services read
with `readPage`, and pages render `Pager` (Previous, Page N, Next) from `pagerLinks` (`src/app/_lib/paging.ts`),
which keeps the list's filters. The page number is a label the links count, not an offset. Previous reaching the
start with less than a page left shows the real first page; any other Previous reads one row past the page to know
whether a Next is still there, since the rows after it may have gone (requests decided, people deleted).

### Composition root

Services receive a `ServiceContext` (`src/server/context.ts`): the database handle, a mailer, a `defer`
function, the app's base URL, a clock, `issueSignInLink` (makes a one-time sign-in link without sending it,
for invites), and, since M6, `secrets` (seals webhook secrets), `webhookTargets` (the URL policy) and `adapters`
(the adapter registry). The app builds the real one in `src/server/runtime.ts` (`db`, nodemailer, `after()` from
`next/server`, `BETTER_AUTH_URL`, Better Auth's magic-link endpoint, `WEBHOOK_ENCRYPTION_KEY`, the
`WEBHOOK_ALLOW_*` flags, the installed adapters, and `wake`, the inline background tick when that mode is on);
`backgroundContext()` is the same without `after()` or `wake`, for ticks that run outside a request. The worker
builds its own with `scriptContext` (`scripts/script-context.mts`). Tests build theirs against a throwaway database. This keeps services free of Next.js and of the app's environment.

## Cross-cutting conventions

### Signing in

Invite-only: an admin (or the first install) creates every account, and no sign-in method creates one. People sign in
with an emailed magic link, Google when it is configured, or a **passkey** (Better Auth's passkey plugin,
`@better-auth/passkey`; credentials in the `passkey` table). A passkey is added on the account page, so only by
someone already signed in (`registration.requireSession`), and removed there too; Home suggests one until the person
has any. The sign-in page offers "Sign in with a passkey", and the email field lets the browser suggest saved passkeys
(`autocomplete="email webauthn"`, conditional mediation). Every method ends in the same session hook, which refuses a
deactivated person; a delete removes their passkeys with the rest of their sign-in data (`deleteSignInOf`).

A passkey is bound to a domain (the relying party ID): the host of `BETTER_AUTH_URL`, or `PASSKEY_RP_ID` when set to a
parent domain of it (`passkeyRelyingParty`, `src/lib/passkey-rp.ts`, checked at start). Set the parent domain before
anyone adds a passkey if the app will move between its subdomains: a passkey made for one host does not work on another.

### Actor and authorization

`requireActor()` (`src/lib/auth.ts`) returns the session user and an `Actor` (`id`, `companyId`, `role`,
`canSelfApprove`, and `source`: how they are acting, recorded on every change they make; see
[Attribution](#attribution-who-or-what-made-a-change)). Every service that acts for a person takes the `Actor`. `company_id` always comes from the
actor, never from input, and every query is scoped by it. A request id from another company is
indistinguishable from one that does not exist (`not_found`).

`actor` is `null` for a user not yet attached to a company; pages show a calm "ask an admin" message.

### Errors

Expected failures throw `DomainError` with a stable `code` (`src/domain/errors.ts`). Server actions run
service calls through `runActionWith` (`src/app/_lib/run-action.ts`), which maps each code to a calm message and logs
anything else as `<event>_failed`, returning a generic retry message. Stack traces never reach the browser.

Some codes carry structured `details` so the message can be specific without parsing text:
`insufficient_balance` carries the year, the days requested in it and the days left, and `messageForError`
words it ("That's 5 days, but you only have 2 days left for 2026."). Codes that mean the deployment is
misconfigured rather than that the person erred (`policy_unavailable`) are also logged as
`<event>_misconfigured`.

The logger (`src/lib/log.ts`) redacts errors before writing them: a Drizzle query error keeps its SQL and the
driver's code and message but not its bound parameters (notes, reasons, audit JSON), and an SMTP error keeps
its codes and command but not the server's reply, which quotes the recipient's address.

### Audit log and events outbox

Every state change calls `recordChange(tx, { source, audit, event })` (`src/server/repositories/change-log.ts`) in
the same transaction as the change; `source` says who or what made it ([below](#attribution-who-or-what-made-a-change)).
The audit row names the person the change is about in
`subject_user_id` (a request's requester, an allowance's or feed's owner, a person an admin edited; `null` for
company-wide things such as holidays), so the audit viewer can filter by person on one index. Migration `0007`
backfilled it for rows written before M5. It takes a `Transaction`, not the pool, so it cannot be called outside
one. `audit_log.created_at` and `events_outbox.created_at` default to `clock_timestamp()`, so rows written in
one transaction (e.g. `leave.requested` then `leave.approved` for a self-approved request) keep their order.

Two documented exceptions. A person's own colour mode is a display preference: changing it writes no audit row and no
event (see Look, above). And the one-time import (M7, below): each imported row is audited (`import.*`
actions, written in bulk with `insertAuditEntries`) without a per-row event, and the import writes a single
`import.completed` event instead.

#### Attribution: who or what made a change

Nothing is anonymous. Every change names a `ChangeSource` (`src/domain/change-source.ts`), one of:

| `kind` | Who or what | Example label in the audit log |
| --- | --- | --- |
| `user` | A person, directly, or through something they started (`via`) | "Peter Krzyzek", "Peter Krzyzek, via Gusto sync" |
| `api_key` | A person's API key: the key's creator and the key, optionally `via` something | "Peter Krzyzek, via API key ‘Zapier’ (ooohm_ab12cd34…)" |
| `system` | A process with no person behind it (`process`), optionally run for a person who asked for it ahead of time (`requestedBy`) | "System: year rollover", "System: scheduled Gusto sync", "System: scheduled deletion, requested by Peter Krzyzek" |

`via` and `process` share one vocabulary of stable identifiers: `year_rollover`, `retention`, `adapter_sync:<adapterId>`,
`timeoff_import`, `scheduled_scrub`, `people_import` (an admin adding people and departments from a CSV file) and the others in
`CHANGE_PROCESSES`. They are stored and published, so never rename one.
`changeSourceLabel` (pure) turns a source into the label above.

How sources are chosen, type-enforced so a new call site cannot leave one out (every recorder takes a required
`source`; there is no default):

- A person in the app: `actor.source`, `{ kind: "user", userId }` from `toActor`. Admin changes go through
  `recordAdminChange(tx, actor, …)`, which records `actor.source`. A future API write path builds an `Actor`
  whose `source` is the key (`byApiKey`); the v1 API is read-only, so nothing writes one yet.
- The year rollover: `system` / `year_rollover`. An admin's (or a sync's) edit of last year re-runs the
  rollover's step for that person (`recarryMemberLeaveType`); the carry rows it writes record **the edit's** source,
  since the edit caused them.
- An adapter's inbound sync (`applyInboundSync`) takes a `SyncTrigger` from its caller: `{ kind: "admin", actor }`
  (Sync now) records the admin `via: "adapter_sync:<id>"`; `{ kind: "schedule" }` records `system` /
  `adapter_sync:<id>`. No scheduled sync runs in v1; the trigger is there for the first adapter that needs one.
- Retention prunes delivery machinery, not state, and writes no audit rows; `retention` is named for when it does.
- The TimeOff import (M7) is started by a person, so it is that person's change: `{ kind: "user", userId: <admin>,
  via: "timeoff_import" }` on every audit row it writes and on `import.completed`. The CLI's required `--actor <email>`
  names the admin; it is resolved inside the import's transaction, after people are imported, and must be an
  active admin of the target company (existing, or just imported with `--create-company`, which only runs when no company exists yet), or the import rolls back.
- A full-scrub delete that waited out the company's grace period ([People lifecycle](#people-lifecycle-and-privacy-m8))
  is run by the daily job: `{ kind: "system", process: "scheduled_scrub", requestedBy: <the admin who asked> }`. The
  process made the change, so `actor_id` stays empty; `requestedBy` only names who asked, and the label reads
  "System: scheduled deletion, requested by <name>" (the admin's tombstone name, if they were deleted since).

Storage (`audit_log`, migration `0010`): `actor_kind` (`user` | `api_key` | `system`, not null), `actor_id` (the
person), `api_key_id` (FK to `api_keys`, `set null`), `actor_via`, `actor_process`, and since migration `0012`
`actor_requested_by` (FK to `user`, `set null`). A `CHECK` requires a `system` row to name a process and nobody; a
`user` row has no key, process or requester; an `api_key` row has no process or requester. **A person's row does not
require `actor_id`**: the foreign key is `on delete set null`, and a check that required it would make deleting a
`user` row fail. OOOhm never removes a `user` row (deleting a person turns the row into a tombstone, below), and the
TypeScript types require the id on every write, so in practice it is always set; if a row were ever removed, its
changes would stay a person's (`actor_kind = 'user'`) and the viewer would say "A deleted person". No name is copied
into the log's actor columns: a person's changes on other people's records show their tombstone name once they are
deleted.

Migration `0010` backfilled older rows: a row with `actor_id` became `user`; one without, `system`, with
`process` `year_rollover` for `allowance.carried_over` and `allowance.created` (only the rollover's step wrote those
without an actor), `adapter_sync:<id>` for the inbound sync's rows (identified by `after.source = "adapter:<id>"`
on `user.*` rows and `after.reason = "Synced from adapter:<id>"` on `allowance.synced`; with an actor, that becomes
the actor's `via` instead), and `unknown` for anything else.

Every event payload publishes the same source as **`actor`** (added within version 1), next to `actorId`, which
stays the person or `null` for compatibility: `{ type: "user", id, via? }`, `{ type: "api_key", id, apiKeyId,
via? }` (`id` is the key's creator) or `{ type: "system", process }`. `recordChange` writes both from `source`,
so an event and its audit row can never disagree. The import's bulk `insertAuditEntries` takes one `source` for
the whole batch and writes the same columns.

Leave events (`src/domain/events.ts`) are a public contract for webhooks and adapters (M6):

| Event | When | `status` in payload |
| --- | --- | --- |
| `leave.requested` | Every submit, including self-approved ones | `pending` |
| `leave.approved` | An approver or admin approves, or self-approval at submit | `approved` |
| `leave.rejected` | An approver or admin declines | `rejected` |
| `leave.cancelled` | The requester cancels a pending or approved request (approved leave of a past year cannot be cancelled) | `cancelled` |

Payload (v1): `requestId, userId, leaveTypeId, startDate, endDate, dayPortion, days, status, actorId, actor`. Add
fields; never rename or remove one. Every payload below also carries `actor` beside `actorId`.

Balance events (M3):

| Event | When | Audit `action` |
| --- | --- | --- |
| `balance.adjusted` | The year rollover sets a carried-over amount (`reason: "carryover"`) | `allowance.carried_over` |
| `balance.adjusted` | The year rollover creates an allowance row from the leave type default, or copies it from the person's latest row for a type without a default (`reason: "allowance_created"`) | `allowance.created` |
| `balance.adjusted` | An admin sets a person's allowance `days` or `adjustmentDays` for a year (`reason: "admin_edit"`, M5). The admin's typed reason is in the audit row's `after.reason` only, never the payload | `allowance.edited` |
| `balance.adjusted` | An adapter's inbound sync sets `days` (and `adjustmentDays` when it sends one) (`reason: "sync"`, M6) | `allowance.synced` |

Payload (v1): `allowanceId, userId, leaveTypeId, year, days, carriedOverDays, adjustmentDays, reason, actorId`,
the row after the change. The rollover has no person behind it: `actorId` is `null` and `actor` is
`{ type: "system", process: "year_rollover" }` (a re-carry caused by an edit names that edit's source instead).

Calendar feed events (M4):

| Event | When | Audit `action` |
| --- | --- | --- |
| `calendar_feed.issued` | A person creates a feed link, or gets a new one | `calendar_feed.issued` |
| `calendar_feed.revoked` | A person gets a new link (`reason: "regenerated"`, written before the `issued` for the new one) or turns the feed off (`reason: "turned_off"`), or an admin deactivates the person (`reason: "deactivated"`, actor = the admin, M5) | `calendar_feed.revoked` |

Payload (v1): `feedId, userId, kind, reason, actorId` (`reason` is `null` on `issued`). Neither the payload nor
the audit row (`kind, createdAt, revokedAt`) ever holds the token or its hash.

Admin events (M5), registered in `ADMIN_EVENT_TYPES` (`src/domain/events.ts`). For each, the audit `action` is
the event type, and `actorId` is the admin unless a row below says otherwise (a self-rename, an adapter sync or a
scheduled scrub).

| Event | When | Payload (v1) |
| --- | --- | --- |
| `user.created` | An admin invites someone | `userId, email, name, role, departmentId, managerId, canSelfApprove, isActive, actorId`: the person after the change |
| `user.updated` | An admin changes name, department, manager, role or self-approval; or a person changes their own name on `/account` (actor = that person) | same |
| `user.deactivated` | An admin deactivates someone | same |
| `user.reactivated` | An admin reactivates someone | same |
| `user.invite_resent` | An admin sends someone a new sign-in link | same |
| `user.deletion_scheduled`, `user.deletion_cancelled` | An admin asks for a full scrub with the grace option on; an admin undoes it (or reactivates the person) | `userId, scheduledFor, actorId` |
| `user.deleted` | A person is deleted (M8). The one admin event a system process can also make: a scheduled scrub's actor is `{ type: "system", process: "scheduled_scrub", requestedBy }` | `userId, mode ("scrubbed" \| "records_kept"), deletedAt, actorId`: no name or email |
| `department.created`, `.renamed`, `.deleted` | | `departmentId, name, actorId` (the name before, on `deleted`) |
| `leave_type.created`, `.updated`, `.archived`, `.unarchived`, `.reordered` | | `leaveTypeId, code, name, color, isPaid, countsAgainstAllowance, defaultAllowanceDays, carryoverEnabled, carryoverMaxDays, sortOrder, archived, actorId` |
| `holiday.created`, `.renamed`, `.deleted` | | `holidayId, date, name, actorId` |
| `company.updated` | Company settings, appearance or logo saved | `companyId, name, timezone, workingDays, allowancePolicy, deletionGrace, managersSeeDetails, approvalMode, colleagueVisibility, departmentScoping, theme, accentColor, corners, requestStyle, layout, logo, actorId` |

Two more events are not admin events: `LEAVE_REASSIGNED_EVENT_TYPE` (M5) and `LEAVE_RECOUNTED_EVENT_TYPE`, outside
`ADMIN_EVENT_TYPES`; their audit `action` follows the leave request actions instead of the event type.

| Event | When | Audit `action` | Payload (v1) |
| --- | --- | --- | --- |
| `leave.reassigned` | A pending request moves to another approver: its approver was deactivated or demoted from admin, the requester's manager changed, or someone was invited as admin, promoted to admin or reactivated who can now take a request an admin had routed to themself (actor = the admin) | `leave_request.reassigned` | the `leave.*` payload plus `previousApproverId, approverId` (either may be `null`) |
| `leave.recounted` | A holiday or working-days change changed a pending or approved request's days, its total or only its split between years (so `days` may equal `previousDays`) (actor = the admin, `via` `holiday_change` or `working_days_change`) | `leave_request.recounted` | the `leave.*` payload (new `days`) plus `previousDays` |

No payload ever holds a session, token, sign-in link or the admin's free-text reason. Emails are in `user.*`
payloads because integrations sync people by address. Since M6, `user.created` and `user.updated` can also come
from an adapter's inbound sync; their `actorId` is then the admin who started it (`actor.via` names the sync), or
`null` for a scheduled one (`actor` names the process).

Integration events (M6), registered in `INTEGRATION_EVENT_TYPES`; the audit `action` is the event type and the
actor the admin. Payloads carry a webhook URL's origin only (paths often hold a token), never a secret, key or
hash.

| Event | Payload (v1) |
| --- | --- |
| `webhook_endpoint.created`, `.updated`, `.enabled`, `.disabled`, `.secret_rotated`, `.deleted`, `.pinged` | `endpointId, urlOrigin, description, eventTypes, enabled, actorId` |
| `webhook_endpoint.updated` also | `urlChanged` (boolean): the full URL changed, even if `urlOrigin` did not |
| `webhook_delivery.redelivered` | `endpointId, deliveryId, eventId, eventType, actorId` |
| `api_key.created`, `api_key.revoked` | `apiKeyId, name, prefix, scopes, actorId` |

Import events (M7), registered in `IMPORT_EVENT_TYPES`. The actor is `null` (the import runs from the command
line). Every imported row has its own audit row (`import.company`, `.department`, `.leave_type`, `.holiday`,
`.user`, `.allowance`, `.leave_request`), with no event of its own, including a carried-over amount the import's
rollover step corrects.

| Event | When | Audit `action` | Payload (v1) |
| --- | --- | --- | --- |
| `import.completed` | A one-time import (v1: TimeOff.Management) committed | `import.completed` (flat counts, file name and hash) | `importRunId, source, sourceSha256, counts {people, departments, leaveTypes, holidays, allowances, leaveRequests}, mismatches, actorId` |

[docs/api.md](api.md#events) is the public catalogue of every type and payload, with the envelope they are
delivered in.

### Dates

Leave dates are `YYYY-MM-DD` strings end to end (`date` columns in `mode: "string"`). Arithmetic runs on UTC
epoch days in `src/domain/calendar-date.ts`, and display formatting (`src/lib/format.ts`) formats in UTC, so
a stored day never shifts with the server's or browser's time zone. "Today" is computed in the company's
time zone (`todayInTimeZone`).

### Email

Every email a change sends goes through one module, `src/server/notifications`:

- `catalog.ts` lists each notification type (`leave.requested`, `leave.approved`, …, `invite`) as a
  `NotificationType`: how to build its email from its data, and what to log if that fails.
- `templates/` holds the pure renderers (`leave.ts`, `invite.ts`) on the shared layout in `src/lib/email-layout.ts`.
  The leave emails share one layout; each kind supplies only its words (`LEAVE_COPY`).
- `send.ts` sends after commit: it reads the company's accent once (`accent.ts`), builds each email, and isolates
  each send.

A service's `work` callback returns `{ result, notify }` to `commitThenNotify(ctx, companyId, work)`, which returns
`result` once the change commits; each notification is `{ type, to, data }`. A service never renders or sends an email itself. To add an email, write its template, add a catalog
entry, and return it from the service. The sign-in link someone asks for on the sign-in page is the one email outside
the module: Better Auth sends it (`src/lib/auth.ts`, template in `src/lib/sign-in-email.ts`), outside any change.
`tests/unit/email-output.test.ts` pins every email's output; update its snapshot only for a deliberate change.

**Admin → Emails** (`/admin/emails`, `src/server/services/admin-emails.ts`) lets an admin replace one email's subject
and message with the company's own words. Each catalog type carries its editable copy (`EditableCopy`): a default
subject and message written with `{{variable}}` placeholders, the variables it offers (`{{requester}}`, `{{dates}}`,
`{{days}}`, …), and sample data for the editor's live preview. Rules (`src/domain/email-template.ts`):

- Only the subject and the message change. The request's details (the note, who else is off, a decline reason), the
  buttons, the links, the approve note and the layout stay as OOOhm sends them, so no wording can break an approve
  link or drop the request's details. Which variables the subject and message name is the admin's choice.
- Copy is checked on save: a variable the email does not have, a subject over 150 characters or a message over 2,000
  is refused (`invalid_input` with the field). A blank field, or one typed exactly as the default, stores nothing.
- Filling never makes markup: values and the copy itself are HTML-escaped, a value is never read as a template, and
  the subject is filled onto one line (capped at 200 characters), so nothing typed can add a header.
- The message's first paragraph leads the email (its heading); later paragraphs (after a blank line) follow the
  request's details, before the buttons.
- Copy lives in `email_templates` (one row per company and type). `send.ts` reads it once per change, after commit,
  with the accent. If it cannot be read, the email goes out in its default words; a saved field that names a variable
  the email no longer has goes out (and opens in the editor) as that field's default, and a subject that fills to
  nothing goes out as the default subject.
- Saving and resetting take the company lock. When the copy in force changes, they write an audit row
  (`email_template.updated`, `email_template.reset`, before and after) and an outbox event of the same name
  ([docs/api.md](api.md)); saving the same words again, or resetting an email already on its defaults, writes neither.

By default, notification emails have fixed subjects, except the request email's, which names the requester and the
dates; a company's own subject (above) is filled the same way. Notes and reasons go in the body only (HTML-escaped
there), never in a header; names are collapsed to one line of at most 100 characters, so the one that reaches a
subject cannot add a header. Better Auth's `/update-user` stays disabled: people change their own display name only on `/account`
(`renameSelf`), which normalizes it and records it as their own `user.updated`, since a name reaches approvers'
inboxes and emails. Sends run after commit (`after()` in the app), each in
its own try/catch; failures are logged as the type's failure event (`leave_email_failed` with the request id and email kind, or
`invite_email_failed` with the person's id), never the
address, and never fail the user's action.

## Leave requests (M2)

### Submitting

`submitLeaveRequest` (`src/server/services/leave-requests.ts`):

1. Validates the range (`assertValidRange`): real dates, end on or after start, at most 366 calendar days,
   half days (`am`/`pm`) on a single date only. Normalizes the note (trimmed, max 500 characters).
2. Locks the requester's `user` row (`SELECT ... FOR NO KEY UPDATE`), which serializes concurrent submissions
   by the same person so two overlapping requests sent at once cannot both pass the overlap check. The weaker
   lock mode matters: `FOR UPDATE` conflicts with the `FOR KEY SHARE` lock a foreign-key check takes, so two
   people who approve each other submitting at once would deadlock. Under the same lock, a person who has
   created 10 requests (any status) in the last 10 minutes is refused with `rate_limited`, which also caps
   the review and cancellation email one person can cause.
3. Runs `assessLeaveRequest` (`src/server/services/balances.ts`), the same function the live preview runs:
   1. Requires an active, non-archived leave type of the actor's company, and resolves the company's
      allowance policy.
   2. Counts days server-side, split by calendar year: working days (company `working_days`, ISO weekdays)
      from start to end inclusive, minus company holidays; a half day is 0.5. A request worth 0 days is
      refused (`zero_days`), naming the holidays it fell on ("Fri, Dec 25, 2026 is Christmas Day, a company
      holiday, so there's nothing to request.").
   3. Refuses an overlap with the requester's own pending or approved requests. A morning and an afternoon
      half day on the same date do not overlap.
   4. Refuses (`insufficient_balance`) when a tracked leave type's balance cannot cover the request in any
      year it touches. See [Balances](#balances-m3).
4. Resolves the approver with the company's rule (`approvalRuleFor(companies.approval_mode)`: `ManagerApprovalRule`,
   or `HeadsUpApprovalRule` while approval is turned off) and stores `approver_id`.
5. Inserts as `pending` with `days` = the total, stores the per-year split in `leave_request_days`, and records
   `leave.requested`. If the rule says self-approve, it immediately moves to `approved` (`decided_at` = now,
   approver = requester) and records `leave.approved`. Self-approved requests are held to the same balance.

**Approval turned off (heads-up time off).** Admin → Company, "Time off approval": `Ask first` (`required`, the
default) or `Just let us know` (`heads_up`, `companies.approval_mode`). Some teams treat time off as something
people tell the company rather than ask for. With `heads_up`, every submit is approved on the spot, exactly as a
self-approved one (`approver_id` = requester, both transitions by the requester, same balance check), and the
person the manager rule would have routed it to (minus self-approval: the active manager, else the
longest-standing other admin) gets a "heads-up" email instead of a review email. Nobody to tell never blocks a
submit. Cancelling such time off emails that person too. Home's form reads "Book time off". The switch applies to
requests sent from then on; pending ones stay with their approver. It is audited and carried on
`company.updated` (`approvalMode`). The setting lives on the company, the tenant every rule is scoped to, so it
moves with the company if one deployment ever hosts several.

**Added for someone.** An admin (for anyone in the company) or a person's direct manager can add time off for
them from their Team page (`addLeaveFor`, `src/server/services/leave-on-behalf.ts`; Admin → People links
there). It runs the same checks as the person's own submit, under the person's member lock, and is stored as
theirs with the one adding it as approver, approved on the spot: `leave.requested` then `leave.approved`, both
with that admin or manager as actor, so the audit log names them. Nobody adds for themself. The person gets an
"added for you" email and can cancel it like any request of their own. A manager who may not see the person's
balance (`managers_see_details` off) gets the cost but never what is left, in the preview or a shortfall.

### Approval rule

`ApprovalRule` (`src/domain/approval-rule.ts`) is pluggable; v1 ships `ManagerApprovalRule` (and
`HeadsUpApprovalRule` for companies that turned approval off, above):

1. `can_self_approve` → approved on submit.
2. An active manager (other than the requester) → routed to the manager.
3. Otherwise the longest-standing active admin other than the requester (oldest `created_at`, then id).
4. Otherwise, if the requester is an admin → routed to themself (a company's only admin can still take time
   off, and is the one exception to "nobody decides their own request").
5. Otherwise → `no_approver`: "ask an admin to set your manager".

### Status machine

```
pending ──► approved ──► cancelled
   │
   ├──────► rejected
   └──────► cancelled
```

Nothing else is legal (`src/domain/request-status.ts`). The requester may cancel a pending or approved
request, except **approved leave of a closed year**: one whose end date is before January 1 of the current year in
the company's time zone (`isClosedYearLeave`). Nobody may cancel that, the requester or an admin; the service
refuses with `past_year_closed` and the dashboard shows no Cancel button (`getDashboard` returns `cancellable` per
request). That leave was taken and its year's balance is settled and carried over, so a past year is corrected with
an admin's balance adjustment for that year instead. A request spanning New Year counts by its end date: Dec 29 to
Jan 2 can still be cancelled in the new year, since part of it is in the open year (cancelling it gives back the
days of both years). A pending request from a past year can still be withdrawn: it was never granted.

Approved leave of the open year that is **over** (its last day is before today, in the company's time zone:
`isLeaveOver`) can't be cancelled by its requester either; the service refuses with `leave_taken`, and
`cancellable` is false. It was taken, so cancelling it would quietly hand the days back. A correction is for their
direct manager or an admin (`canCorrectLeaveFor`, the same people who may add leave for them): `removeLeaveFor`
(the **Remove** action on the person's Team page, which for them also lists this year's leave from before its
60 days) cancels approved leave that isn't from a closed year, past or future (`canRemoveOn`), with a required reason stored in `decision_note`. It is recorded as `leave_request.cancelled` and
`leave.cancelled` by the one removing it, so the audit log names who and why (its `before` keeps the approver's
earlier note), and the person is emailed (`removed`). To change dates, remove the leave and add the right ones. A
closed year's leave still can't be removed. Any admin of the company, or the assigned approver, may approve or reject a pending request, with an
optional reason (max 500 characters) stored in `decision_note`. Every status change is a compare-and-set
(`UPDATE ... WHERE status = <expected>`), so of two concurrent decisions exactly one wins and the other gets
`conflict`.

**A stored assignment grants the right to decide only while it still matches the approval rule** (`canDecide`,
`src/domain/leave-permissions.ts`). When the right rests on the assignment (a non-admin approver, or an admin
deciding their own request routed to themself), `decideLeaveRequest` reads the requester, their manager, their
department's manager and the active admins (`loadApprovalContext`, `src/server/services/approval-routing.ts`) in the same transaction and asks `reassignApprover` who should decide now; anyone else gets
`forbidden` and the request is left to the admins, who see every pending request. Its compare-and-set then also
requires `approver_id` to still be the actor, so it loses (`conflict`) to a concurrent re-route. This closes the
window a submit leaves open: submit reads the manager and the admins without locking them (a shared lock on the
approver would bring back the deadlock between two people who approve each other, see step 2 of
[Submitting](#submitting)), so a submit racing a deactivation or demotion can still store an approver that the
admin change meant to remove. Nothing re-routes that request, and its review email may have gone to the
person just removed; but they cannot decide it, and every admin sees it in their inbox. Admins deciding someone
else's request skip the check (no extra reads).

### Emails

How mail leaves: services only ever call `ctx.mailer` (`Mailer`, `src/server/context.ts`), which the composition root
wires to `sendMail` in `src/lib/mail`. That sends through the `MailTransport` that `MAIL_TRANSPORT` names, built on
first use from `registry.ts`: `smtp` (nodemailer; `smtp-options.ts` decides TLS) or `sendgrid` (one HTTPS request to
SendGrid's Mail Send API, with click and open tracking off so token links reach people unchanged). A transport
resolves once its provider accepts the message and throws `MailSendError` (the provider and its answer, never a
credential) otherwise. Adding a provider is one file implementing `MailTransport` and one registry entry.


| Transition | Recipients |
| --- | --- |
| Requested (routed) | Approver (not when it is the requester), with who else is off then |
| Requested (self-approved) | Requester gets "approved"; no review email |
| Requested (approval turned off) | Requester gets "booked"; their manager (else the fallback admin) gets a heads-up, with who else is off then; no review email |
| Approved | Requester, with the approver's note if they wrote one |
| Rejected | Requester, with the reason |
| Cancelled | Requester, plus the approver unless the approver is the person cancelling; while approval is turned off, cancelling time off the person approved themself also tells their manager now (else the fallback admin) |
| Recounted by a calendar change | Requester only, saying which holiday or the working days changed; not when only the year split moved |

"Who else is off then" (`alsoOffFor`, `src/server/services/also-off.ts`, sentences from `src/domain/overlap.ts`)
is one line about other active people in the requester's department (everyone, when they have none) whose approved
or pending leave costs a working day within the request's dates: "Nobody else in Design is off then.", "Aisha Khan
is off then too." or "Also off then: A, B (not approved yet), C and 2 more." Each person is counted once. It shows
the same names and dates the team calendar shows every member, never a note or a balance. The Approvals page shows
it under each request (three queries for the whole page) and the review email carries it. It is information only and
never blocks a request; rules about how many people may be off at once are a separate, future feature.

Inactive recipients are skipped. Links use `BETTER_AUTH_URL` as the app's base URL.

### Screens

- `/setup` (`runFirstInstall`, `src/server/services/install.ts`): the first install of an empty OOOhm, from the
  browser. Open only while `SETUP_TOKEN` is set and nothing is installed (no `installation` row, company or person);
  otherwise a 404. With the token it creates the company, the default leave types (PTO first) and the first admin
  (`can_self_approve`), audited as that admin `via: "first_install"`, writes the `installation` marker, and sends them
  to sign in (it never signs anyone in: the emailed link proves the address). It runs under the companies table lock
  `pnpm db:seed` and the TimeOff import take, so two racing setups cannot both win. `pnpm db:seed` writes the same
  marker, so either path closes setup for good. Sign-in on an empty install says how to set it up.
- `/` (dashboard): the request form (the one primary action) with its live preview, the person's balance per
  active leave type for the current year, and their latest five requests (with a link to all of them). A pending
  request with someone else says who has it and, once they have decided three requests in the last 180 days, how
  long they usually take (their median, rounded up: "usually decides within a day"). Defaults: first active leave type by
  sort order, the first working day (not a holiday) from today in the company's time zone (`nextWorkingDay`),
  end = start, full day.
  From November 1 (company time zone) a quiet note names the days of the main leave type (the first active one,
  the form's default) that will not carry into next year (what is left minus what carryover keeps), once per
  year per browser. Only that type, so nobody is told to use up sick days. After
  the person's first approved request, a note suggests adding their time off to their own calendar until they
  have a live calendar link in this company (`shouldSuggestCalendarFeed`). Both are dismissed with "Got it",
  kept in `localStorage` under a key that names the person and company. (The expiry reminder is
  on Home rather than by email: the worker that runs daily jobs holds no SMTP settings.)
- Shortcuts: ⌘K (Ctrl+K) on any page for members of a company opens a "Go to" list of the screens the person
  can reach (`JumpMenu`, from the header). On Approvals, J and K move between requests, A approves the focused one, and D
  moves to its reason so Enter declines (`approvals/approval-keys.tsx`); with no request in focus yet, the first of these
  keys focuses the first request. The Approvals shortcuts are off until the person ticks "Keyboard shortcuts"
  above the list (kept per person in this browser's `localStorage`, or in memory where storage is blocked), so single-letter keys never act unasked (WCAG 2.1.4).
  They are ignored while typing and with Shift, Alt, Ctrl or ⌘ held (⌘K/Ctrl+K aside).
- `/requests` ("Your requests", in the account menu): every request the person has sent, latest dates first, ten a
  page. Each is a card (`RequestCard`, shared with the dashboard) that opens `/requests/[id]`; the whole card is the
  link (its dates, stretched over it) and lifts on hover. While a request can be cancelled (pending or approved,
  not approved leave of a closed year) it offers "Cancel request" (`CancelRequest`): one click starts a 20-second
  countdown with Undo, and the cancel is sent when it ends (leaving the page sends it at once).
- `/requests/[id]`: one of the person's own requests in full (type, days, who it waits for or who decided it,
  when it was sent and decided, both notes) with Cancel request. Someone else's request is a 404, as an unknown one
  is. The personal calendar's chips and agenda rows link here.
- `/approvals`: three tabs (`getApprovalTriage`, `TabNav`). **Needs you** holds pending requests assigned to the
  person (for admins, also any with no approver); **Waiting on others**, shown only when it has something, holds
  the pending requests an admin may decide but that are assigned to someone else; **Settled** lists what the
  person approved or declined in the last 30 days (not their own self-approved requests), read from the audit log,
  with each request's current status. Pending requests are earliest dates first, ten a page with Previous and
  Next, each with Approve / Decline, an optional reason the requester sees either way, and the line on who else is
  off then (above). The header links here for managers, admins, and anyone with something currently assigned to
  them.
- `/approve/<token>`: where a request email's **Approve** button lands, with no sign-in. The token
  (`src/lib/email-link-token.ts`) is HMAC-signed claims, not stored: the request, the approver the email went
  to, and a 7-day expiry, under a key derived from `BETTER_AUTH_SECRET` (`ctx.linkKey`; processes without it
  send no such links). Opening the page changes nothing, because mail scanners open links; the Approve button
  (a server action) runs the same `decideLeaveRequest` as the Approvals page, as that approver with
  `via: "email_link"`, so every check still applies and the audit row says how it was decided. A decided
  request makes the link inert. Declining needs a reason, so it happens in the app. The page sends
  `<meta name="referrer" content="no-referrer">` and `noindex`.

## Balances (M3)

### Policy engine

`AllowancePolicy` (`src/domain/allowance-policy.ts`) is pure and pluggable. `companies.allowance_policy` names
the policy and `resolveAllowancePolicy(key)` looks it up; an unknown key throws `policy_unavailable` rather
than falling back, because a fallback would quietly compute wrong balances. A policy answers three questions:
which periods a request draws from and what it costs in each (`periodsFor`), what a balance is (`balance`),
and what carries into the next period (`carryover`). Periods are identified by a year number.

v1 ships `AnnualCalendarYearPolicy` (`annual_calendar_year`), per person, leave type and calendar year:

| Value | Rule |
| --- | --- |
| allowance | `allowances.days` when the person has a row for the year, else `leave_types.default_allowance_days`, else (no default) the `days` of the person's latest row for an earlier year |
| total | allowance + `carried_over_days` + `adjustment_days` (both 0 without a row) |
| used | approved days in the year |
| pending | pending days in the year, shown apart |
| carried out | next year's `carried_over_days`: what the rollover already moved out of this year |
| remaining | total − used − pending − carried out (negative only if an allowance was lowered after booking) |

Carried-out days count as spent in the year they left. Otherwise, once the rollover had carried a year's
remaining forward, leave booked late into that closed year (dates in the past are allowed) could spend the same
days again. Carryover itself is computed from what was left *before* carrying (remaining + carried out), so
re-running the rollover over an earlier carry gives the same answer.

A type is **untracked** (unlimited) when `counts_against_allowance` is false, or when it has no default and the
person has never had a row for it in that year or any earlier one. Untracked balances report used and pending,
have no remaining, and never block. Once a person has a row for a type without a default, every later year
without its own row inherits that row's `days` (with no carryover or adjustment), so the type stays limited for
them before the rollover has made next year's row: booking ahead, and the January part of a request over New
Year, are checked against it. All balance reads load it in the same query as the year's rows (`listAllowances`
also returns each person and type's latest row before the earliest year asked for). Amounts add in tenths (`addDays`), matching the `numeric(5,1)` columns.

### Year split, fixed at submit

`splitLeaveDaysByYear` (`src/domain/leave-days.ts`) counts a request's working days per calendar year: Thu
Dec 31 to Mon Jan 4 (Jan 1 a holiday) is 1 day in the first year and 1 in the next. Submit stores the split in
`leave_request_days (request_id, year, days)` in the same transaction as the request; the rows always add up
to `leave_requests.days`, which stays the total. Balances only ever read these rows. A holiday or working-days
change rewrites them for the years still open (see [Recount after a calendar change](#recount-after-a-calendar-change)),
never for a closed year, so a settled balance never moves. Rejected and cancelled requests drop out because
balances sum only `pending` and `approved` requests.

### Recount after a calendar change

Adding or deleting a company holiday (one, or the US federal set) and changing the working days run
`recountLeave` (`src/server/services/leave-recount.ts`) in the same transaction, under `lockCompany`:

1. It locks (`FOR UPDATE`) the company's pending and approved requests that include a changed date (every open
   one, for working days), skipping dates before Jan 1 of the current year in the company's time zone. Requests
   between two changed dates are not touched.
2. It counts each request with the calendar before and after the change and moves its stored split by the
   difference, per open year (`applyCalendarChange`). Closed years keep their stored days: those balances are
   settled and carried over, so a past year is fixed with an adjustment instead. Applying only the difference
   leaves any earlier correction to the split alone, and the email names only this change. A year never goes
   below 0, and the amount that would have taken it there is not kept: if the stored split already counted fewer
   days than the calendar (an imported split), taking that year to 0 and undoing the change restores the
   calendar's count. Keeping it would need a per-year offset stored with the request.
3. A request whose split changed gets new `leave_request_days` rows and a new `days` total, and writes
   `leave_request.recounted` / `leave.recounted` (payload adds `previousDays`), naming the admin `via`
   `holiday_change` or `working_days_change`.
4. A request that now falls entirely on non-working days is kept at 0 days, never cancelled: nothing comes off
   the balance, the person may cancel it, and undoing the change (deleting the holiday, ticking the day again)
   restores its count. A mistaken change therefore never destroys anyone's leave. Submits still refuse a new
   request worth 0 days; migration `0013` lets a recounted one hold 0 (`leave_requests_days_nonneg`, and a half
   day may be 0).
5. A request that now costs more is kept even if it overdraws a tracked balance, because the time was already
   booked. The admin's confirmation names each balance now over, and the person's email says so.
6. Each request whose total changed emails its requester after commit ("Fri, Dec 25, 2026 is now a company
   holiday (Christmas Day), so the time off below now takes 4 days instead of 5 days."); someone with three
   affected requests gets three. A request whose days only moved between years is audited but not emailed.

The writes are sequential, a handful per changed request. That is fine for a small team; a company with
thousands of open requests changing its working days would want them batched.

Submits take the company row `FOR SHARE` (`shareLockCompany`) before anything else, so a request is never
counted with a calendar that is being replaced: a submit waits for a running recount, and a recount for
submits already counting. `holiday-recount.test.ts` pins this with two connections.

Migration `0004` backfills existing requests: one row at the stored total for a request inside one year; for
one over New Year, the working days counted at migration time up to Dec 31 (capped at the stored total) go to
the first year and the rest of the stored total to the second.

### Enforcement and locking

A request is refused when, in any year it touches, its days in that year exceed that year's remaining.
Pending requests count as spent, so two pending requests cannot promise the same days, and so do days already
carried into the next year, so carryover cannot be spent twice. The check runs inside
the submit transaction under the requester's member lock (`lockMember`, `FOR NO KEY UPDATE`), so concurrent
submits by one person run one after another and each sees the days the previous one booked. **Every writer of
a person's balance inputs takes that lock first**: submit and the year rollover do; admin allowance edits (M5)
do too. Approving never changes remaining (pending and approved both count), and rejecting or cancelling only
frees days, so neither needs it.

### Live preview

The request form asks `GET /api/leave-preview?leaveTypeId=&startDate=&endDate=&dayPortion=` 300 ms after the
last change, and shows the answer in an `aria-live="polite"` line that the submit button also references
(`aria-describedby`): "This request takes 3 days. Afterwards you'd have 12 days left for 2026.", or the exact
message submit would give ("That's 5 days, but you only have 2 days left for 2026.", "Those dates are all
weekends or holidays..."). After a successful submit the fields reset and the line stays empty until the draft
changes (`showsPreview`), so it never describes the blank form as if it were the request just sent; the
confirmation next to the button names what was sent ("Sent for approval: Mon, Nov 9 to Fri, Nov 13, 2026
(5 days).").
The route handler calls `previewLeaveRequest`, which runs `assessLeaveRequest` without writing; the client
does no day counting. A newer draft aborts the previous request, so answers never arrive out of order. It is
a route handler rather than a server action because Next.js runs a client's server actions one at a time,
and a preview must never queue in front of a submit. Responses are `Cache-Control: private, no-store`;
without a session it answers 401. It allows 60 previews per person per minute (an in-memory fixed window,
`src/lib/rate-limit.ts`; 429 beyond that), far above what the debounced form sends, so a script cannot hammer
the database or, with a misconfigured policy, flood the error log. While a newer answer is on its way the last
one stays on screen in the muted colour with `aria-busy`, never with opacity, which would take the red error
text below AA contrast.

### Dashboard summary

`getBalanceSummary` returns every active leave type's balance for the current year in the company's time
zone: four queries whatever the number of types or requests (settings and types, then allowance rows and a SQL
`sum ... filter (where status = ...)` over `leave_request_days`, each pair in parallel). The dashboard
(`getDashboard`) reads settings and types once for both the form and the balances (`summarizeBalances`), so it
is a fixed six queries: settings, types and the person's requests, then allowance rows, booked-day sums and the
look-ahead holidays. `balances.test.ts` pins that number. Each card shows what is left, then what it is out of,
broken down when it is more than the allowance ("of 18 days (15 + 3 carried over)"), then used and pending.
If the policy is unknown, the dashboard logs `allowance_policy_unavailable` and shows a calm "ask an admin"
line in place of balances; everything else still renders.

### Year rollover

`runYearRollover(ctx, fromYear?)` (`src/server/services/rollover.ts`) closes a year. For every company, active
member and active leave type that counts against allowance with `carryover_enabled`, next year's
`carried_over_days` becomes `clamp(remaining(fromYear) + carried out, 0, carryover_max_days)`, i.e. what was
left before any earlier carry (no upper bound when the max is null). A missing next-year row is created from
the type's default. Members created after the closing year carry nothing. For every counting type without a
default, **carryover on or off**, anyone with a row in or before the closing year gets a missing next-year row
copied from their latest one (`days`), even when nothing carries. Balances would inherit that row anyway (see
above); the copy makes next year's allowance an explicit row an admin can see and edit. Nobody who never had a
row for such a type gets one.
Then every active member gets a current-year row from the default for each tracked type that has one;
existing rows are never overwritten.
Carryover is off by default, so out of the box nothing carries: the job only creates missing rows.

It **sets** values rather than adding to them, so it is idempotent: a second run over the same data changes
and records nothing. If closing-year leave is cancelled later, the next run recomputes the carryover and
records the change. Each member runs in its own transaction under their member lock, and every created or
changed row writes `audit_log` + `balance.adjusted` in that transaction. It refuses (`invalid_input`) to close
a year that has not ended in a company's time zone, and resolves every company's policy before changing
anything.

**The rollover owns `carried_over_days`.** Every run recomputes it from the closing year, so a hand edit there
is overwritten (and audited as "System: year rollover") by the next run or restart. Admin overrides (M5) write `days` and
`adjustment_days`, which the rollover never touches, and never `carried_over_days`.

Run it with `pnpm job:rollover [year]` (default: the previous year in each company's time zone; needs only
`DATABASE_URL`). The compose `migrate` service runs it after the seed on every start; a failure there is
printed but does not stop the app, since balances work without it and only carryover waits.

Since M6 the outbox worker runs it **daily** on its own ([Scheduled jobs](#scheduled-jobs)), so a host cron is
optional. Without the worker, schedule it **daily** from a host cron. Running only on Jan 1 is not enough: the carryover
must be recomputed when December leave that was still pending is rejected or cancelled in January, and cron
fires in the host's time zone, so on a UTC host 00:15 on Jan 1 is still Dec 31 for a company in the Americas;
the job would close the year before last (a no-op) and skip the year that just ended. A daily run is
idempotent, quiet when nothing changed, and catches both: even in the wrong zone, the next day's run closes the
year. Set `CRON_TZ` to the company's zone where your cron supports it (cronie does) so it closes on Jan 1
itself:

```cron
CRON_TZ=America/Chicago
15 3 * * * cd /srv/ooohm && docker compose run --rm migrate pnpm job:rollover
```

## Calendar (M4)

### Screens

- `/calendar?month=YYYY-MM`: the person's own month. A Monday-first grid (ISO weeks, matching the company's ISO
  working days) at `md` and wider, an agenda list below that. Approved leave is a solid chip in the leave
  type's colour (black or white text, whichever reads better: `readableTextColor`); pending leave is a dashed
  outline whose label says "pending", so the difference never rests on colour. Half days read "PTO (AM)" /
  "PTO (PM)". Rejected and cancelled leave never shows. This month's working days are plain; its weekends
  (non-working days) and holidays (named) are hatched; the neighbouring months' days have no fill and a faded
  number, so the three never look alike. A request shows only on the days it costs: not on a weekend or holiday
  inside its range. The agenda follows the same rule: it lists a request only if it costs at least one day of
  the month. Previous, Today and Next are plain links. The month is parsed with zod; anything malformed
  or outside 1900 to 2999 falls back to the current month in the company's time zone.
  The grid is also a way to ask for time off (`month-grid.tsx`): drag across days, or click one and then
  another (Shift-click works too), and a short form under the month shows the dates, the same live preview as Home
  and a leave type picker, then posts to the same `requestLeaveAction` (full days). With a keyboard, the
  days are one tab stop: arrow keys move, Enter or Space picks a day (a second one stretches the pick to it), Shift with an arrow stretches it,
  and Escape clears it. Each day is a button filling its cell behind the content; its leave chips sit above
  it and stay links to their requests, so a click on a chip opens the request and a drag across chips still
  stretches the pick. Phones keep the agenda; Home's form works everywhere.
- `/calendar?view=year&year=YYYY`: the person's whole year as twelve small months (`getYearCalendar`, three
  queries). Approved leave fills a day in its type's colour, pending leave outlines it, company holidays are
  outlined in ink and today is filled in ink (leave wins over both; today on leave gets an ink ring). The
  squares are hidden from screen readers; each month's heading links to its month view, and its leave and
  holidays are read out as a list instead. A Month / Year switch sits beside the page heading.
- `/team?month=YYYY-MM&department=<id>`: "who's out". Every active member of the company with approved or
  pending leave that costs at least one working day of the month (`entriesCostingDaysIn`: a Thursday-to-Sunday
  request belongs to the Thursday's month, not to the month holding only its weekend), grouped by person (by name), each person's leave by date, pending marked
  "Waiting for approval". Department filters are links ("Everyone", then each department); an id that is not a
  department of the actor's company falls back to everyone. Deactivated people do not appear. Each name opens
  that person's page.
- `/team/[id]` (`getTeamMember`): one active member of the company, in two tiers. Everyone sees what the team
  calendar shows: name, department, manager, and their approved and pending leave from 60 days ago to a year
  ahead (only leave that costs a working day), split into "Coming up" and "In the last 60 days". The person,
  admins, and their direct manager while **Admin → Company → Managers can see their team's balances and notes**
  is on (`companies.managers_see_details`, on by default) also see each request's days, note and approver's
  reason, and this year's balances (`canSeeLeaveDetails`, in `domain/leave-permissions.ts`). For anyone else
  the service drops those fields before returning, so they never reach the page. Inactive, deleted and
  other companies' people are a 404.
- `/calendar/subscriptions`: the two feeds (below), linked from both pages.

**Whose time off a person sees.** One rule, in `domain/calendar-visibility.ts`: `calendarScopeFor(viewer,
company)` returns a `CalendarScope` (`everyone`, `departments`, `team` or `self`), loaded by `scopeOf` /
`loadCalendarScope` (`services/calendar-scope.ts`), and every reader filters by it: Who's out, the calendar's
filters, `/team/[id]` (a 404 outside it) and the team calendar link (its owner's scope, read on every fetch). The SQL form is `scopeCondition` in `repositories/calendar.ts`, which `listTeamEntries` takes;
`canSeeOnCalendar` is the same rule for one person. Admins and managers see everyone. Employees see what
**Admin → Company → People can see the time off of** allows (`companies.colleague_visibility`): everyone (the
default), their team (themself, their manager, the others who report to that manager, and their own direct
reports; with no manager, only themself and their reports), or only their own. An unknown stored value reads as
`self`.

**Department scoping** (Admin → Company → Keep people to their own departments, `companies.department_scoping`,
off by default) narrows that for everyone but admins: managers, and employees who could see everyone, get the
`departments` scope instead, which is themself, their direct reports wherever they sit, and everyone in their own
department and the departments they manage (`departments.manager_id`; one more query, only when the setting is on).
Someone in no department sees themself and their reports. `team` and `self` stay as they are. Under it the
calendar's Everyone pill reads "My department(s)", My team keeps only the people inside those departments, and
Who's out offers only those departments. Approvers' "also off" lines (the approvals inbox and request emails)
are filtered by their reader's scope only while it is on; otherwise they name anyone in the requester's
department, or anyone at all, as before. Reports are unaffected: managers already see only their direct reports
there. A new kind of scope is a new `CalendarScope` case handled in
`canSeeOnCalendar` and `scopeCondition`.

The month view of `/calendar` shows the person's own leave by default; `?show=team` or `?show=everyone` add
colleagues' leave as far as their scope allows (`narrowCalendarScope`: anything else falls back to just them).
The filters are pills under the month links, shown only when there is more than one. A colleague's chip reads
"Ana: PTO" and opens their page; only the person's own chips open requests. The year view stays personal.

The header links Calendar and Team for every member of a company, and on every page but the dashboard a **Request
time off** link to the dashboard's form (`/#request`, an accent outline, so each screen keeps one filled main
action). The person's name opens their own options (`AccountMenu`, a disclosure rather than an ARIA menu: Escape,
an outside click or a navigation closes it): **Your account**, **Calendar subscriptions** and **Sign out**.
`/account` shows their email, role, department and manager, and lets them change their display name
(`renameSelf`, recorded as their own `user.updated`); everything else stays with admins, and the email is the
sign-in identity.

No `proxy.ts` gates routes: each page calls
`requireActor()`, which redirects to `/sign-in` without a session, and the ICS route is public by design.

### Queries

| Call | Queries | What |
| --- | --- | --- |
| `getMonthCalendar` | 3 | settings; then holidays and the person's leave over the grid's dates, in parallel |
| `getTeamCalendar` | 4 | settings and departments in parallel; then the month's holidays and one range query, in parallel |
| `renderCalendarFeed` | 2 or 3 | token lookup; then entries and, only when `last_used_at` is missing or over an hour old, the stamp, in parallel |

The team query is a single join (`leave_requests` → `leave_types`, `user`, `departments`) filtered by
`company_id`, status, `start_date <= last` and `end_date >= first`, served by `leave_requests_company_dates_idx
(company_id, start_date, end_date)` (from M1); no new index was needed. `end_date >= first` cannot bound a btree
scan, so every range query also has `start_date >= first - 365 days` (`earliestOverlappingStart`): a request spans
at most 366 days, which submit checks and the `leave_requests_span_max` constraint (migration `0006`) guarantees,
so the bound hides nothing and the scan reads at most a year before the range instead of the company's whole
history. `calendar.test.ts` seeds 50 people with seven requests each and pins the count at 4, empty or full, and
exercises a request of exactly 366 days ending on the range's first day. Grouping, ordering and the grid are pure
functions in `src/domain/calendar.ts`.

### Privacy rule

A member may see who is out, when, and the leave type's name and colour, for the people their calendar scope
allows (`calendarScopeFor`, above: everyone, unless an admin narrows it for employees). Nobody sees another person's request
note, decision note or balance on any calendar screen or feed. This is enforced by shape, not by filtering: every
calendar view and both feeds are built from `CalendarEntry` (`src/domain/calendar.ts`), and the repository's
calendar queries (`src/server/repositories/calendar.ts`) select only its fields. Notes are left out of the personal
feed too, since a feed URL can travel further than the app. A person with a blank name is labelled by the part
of their email before the `@` (`teamLabel`, `src/domain/person.ts`), never the full address, on the team view
and in the team feed. Emails, which go only to the requester and their approver, still fall back to the full
address (`personLabel`).

### Feed tokens

`calendar_feed_tokens (id, company_id, user_id, kind personal|team, token_hash, token_hint, created_at,
last_used_at, revoked_at)`, migration `0005` (`token_hint`: `0021`).

- A token is 32 random bytes in base64url (43 characters), from `src/lib/feed-token.ts`. Only its SHA-256 (hex,
  `CHECK`ed) is stored, under a unique index; the lookup is one index probe on the hash. A plain hash suffices
  because the input is 256 random bits, not a password.
- The link is shown once, in the server action's response, and never again: OOOhm keeps no copy it could read
  back. Storing the link reversibly so it could be shown twice was considered and refused: a leaked database or
  backup would then hold every live calendar link, and calendar apps fetch without signing in, so a leak would go
  unnoticed. The page shows when the feed was created and last fetched, and its last 4 characters
  (`token_hint`, `CHECK`ed; null for links made before `0021`), so people can tell which link a calendar holds.
  The other 39 characters (234 random bits) stay secret.
- With the new link, the page offers one-tap subscribe links (`addToCalendarLinks`, `src/domain/calendar-feed.ts`):
  Google (`calendar.google.com/calendar/r?cid=webcal://…`), Apple (`webcal://…`) and Outlook on the web
  (`outlook.office.com/calendar/0/addfromweb?url=…`). Each hands the link to that calendar service, as
  subscribing does anyway.
- "Lost it? Replace the link" revokes the live link and issues a new one in one transaction; "Turn off" sets `revoked_at`.
  Both run under the person's member lock, and a partial unique index (`user_id, kind` where `revoked_at is
  null`) backs it up, so one person never has two live links of a kind. Each change writes `audit_log` and
  `events_outbox` rows in the same transaction.
- Listing, regenerating and turning off match the person and kind, not the person's current company, like the
  unique index. A link issued before a company move is listed, revoked by "Lost it? Replace the link" or "Turn off", and its
  revoke is recorded under the company it was issued in. Otherwise it would block a new link (unique index) and
  come back to life if the person moved back. v1 has no way to move people between companies (one
  company per deployment); if one is added, it should revoke their live feeds in the same transaction.
- `GET /api/ics/<token>.ics` needs no session (calendar apps cannot sign in). It answers a bare 404 for a
  malformed token (before any query), an unknown or revoked one, and one whose owner is inactive or no longer in
  the feed's company, so deactivating someone stops their feeds at once. Deactivation (M5) also revokes every live
  link (audited, reason `deactivated`), so reactivating someone revives none: they create new ones.
- Two in-memory limits, both 429 with `Retry-After: 60`. **Fetches per link:** 30 a minute, keyed by the feed's
  id after the lookup (the service's `admit` hook), so only live links occupy that limiter. **Misses per
  client:** 60 fetches a minute that find no live link, per client key. The token is looked up first (one probe
  on the unique hash index); a live link is served whatever the miss budget says, and only a miss checks and
  spends it, answering 429 instead of 404 once the key is over budget. So the miss limit can never refuse a real
  calendar app, which matters because Google fetches every subscriber's feed from a few shared addresses and
  the key may be a bucket anyone can fill. Every limiter holds at most 10,000 keys (`createRateLimiter`'s
  `maxKeys`, dropping the oldest), so made-up keys cannot grow memory without bound.
- **The client key** (`clientAddress`, `src/lib/client-address.ts`). Route handlers do not see the socket, and
  Next's server fills in `X-Forwarded-For` from the socket only when the header is missing: a value the client
  sent is kept as is. So the header is trusted only as far as `TRUSTED_PROXY_HOPS` says, the number of proxies
  in front of the app that each append to it (nginx `$proxy_add_x_forwarded_for`, Caddy, Traefik) or, for the
  first, overwrite it. The key is the entry that many places from the end, the one the outermost trusted proxy
  wrote. With the default 0 (no trusted proxy, as `docker compose up` runs today, with port 3000 published
  directly), a list shorter than the hop count, or an entry that is not an IP address, every caller shares one
  key, `"shared"`: guessing is then capped for everyone at once, and since a miss budget never blocks a live
  link, filling it only turns other people's 404s into 429s. Setting the hop count higher than the real number
  of appending proxies would let a client choose its key again (rotate it to dodge the cap, or name someone
  else's address). `X-Real-IP` is not read. **M7 must deploy behind an appending or overwriting proxy and set
  `TRUSTED_PROXY_HOPS` to match**; that is a requirement for per-client limits, not a refinement.
- It answers `Cache-Control: private, max-age=300` and `Referrer-Policy: no-referrer`, and logs failures with the
  first 8 hex characters of the hash, never the token. The handler body is `handleFeedFetch`
  (`src/app/api/ics/[file]/feed-fetch.ts`), with the context, client and limits injected;
  `tests/integration/feed-route.test.ts` pins its status codes, headers and both limits.
- `last_used_at` is telemetry, not a state change: it is not audited, and is written at most once an hour
  (the service skips the `UPDATE` entirely while the stamp is fresh).

### ICS format

`src/domain/ics.ts` is a pure RFC 5545 writer, unit tested in `tests/unit/ics.test.ts` against a strict parser
(`tests/support/ics-parser.ts`) that integration tests use on real feeds too.

- `VCALENDAR` with `VERSION:2.0`, `PRODID`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-CALNAME` and `NAME`
  ("OOOhm: My time off", "OOOhm: Who's out at <company>"), `REFRESH-INTERVAL;VALUE=DURATION:PT1H` and
  `X-PUBLISHED-TTL:PT1H`.
- One `VEVENT` per approved or pending request: `UID:<request id>@ooohm` (stable for the request's life, so
  clients update rather than duplicate), `DTSTAMP` (when the feed was rendered), `DTSTART;VALUE=DATE` and an
  exclusive `DTEND;VALUE=DATE` (the day after the last day), `SUMMARY`, `STATUS`, `TRANSP` and `LAST-MODIFIED`.
- **Pending leave is included**, as `STATUS:TENTATIVE` with "(pending)" in the title, because Google shows no
  tentative styling; it disappears on the next refresh if declined. Approved leave is `CONFIRMED`.
- Titles use the leave type's short `code`: "PTO", "PTO (AM)", "PTO (pending)" in the personal feed and "Ana:
  PTO (PM, pending)" in the team feed. Personal-feed events are `TRANSP:OPAQUE` (busy); team-feed events, your own included, are
  `TRANSPARENT`.
- TEXT is escaped (`\\`, `\;`, `\,`, line breaks as `\n`; other control characters dropped), lines end in CRLF,
  and every line is folded at 75 octets of UTF-8 without splitting a character.
- The window is 90 days back to 548 days (about 18 months) ahead of today in the company's time zone; a request
  that overlaps it is included whole.

Google Calendar only subscribes to a publicly reachable `https` URL and refreshes on its own schedule (often
several hours, up to about a day), whatever `REFRESH-INTERVAL` says.

## Reports

`/reports` (`getLeaveReport`, `src/server/services/reports.ts`; the rules are pure functions in
`src/domain/reports.ts`) shows how much time off was taken in a year, for admins and managers only
(`canViewReports`): anyone else gets the 404 page, and the header shows the **Reports** link only to them.

- **Scope** (`reportScopeFor`): an admin sees the whole company; a manager sees the people who report to them
  directly. Department pills narrow either; an id that is not a department of the company means everyone.
  People are counted by their department today, not the one they were in when they took the leave.
- **What it shows, for one year** (`?year=YYYY`, else this year): days off, days per active person, days
  waiting for approval and the median time from request to an approver's decision (self-approved requests and
  ones decided as they were made, such as leave added for someone, are left out); twelve stacked columns by
  leave type, with a tick at the year before's total for the same month, and months after today's lighter
  (booked, not yet taken); a running total through the year as a line over last year's (`runningTotal`,
  dashed where booked ahead); five years of totals; days by leave type, by department (per active person),
  request counts by status, and a table of people. Inactive people appear only with leave in the year.
- **Days come from each request's stored split** (`leave_request_days`), the same numbers balances use, never
  a recount. Only spreading a year's days over its months uses the calendar (`allocateYearToMonths`): when a
  closed year kept its days after a later holiday change, the stored days are shared out in proportion, so the
  months always add up to the year.
- **Privacy.** Days taken are not private (the team calendar shows who is off and when), so every report
  shows them. **Days left** follows the team member page's rule (`canSeeReportBalances`): admins always,
  managers while **Managers can see their team's balances and notes** is on. Notes and decision notes are
  never selected.
- **CSV.** `GET /reports/export` (same query) downloads the people table with a column per leave type
  (`reportCsv`). Like the person export, it refuses a request `Sec-Fetch-Site` marks as from another site (anything but
  `same-origin` or `none`); a browser too old to send the header is let through, and the session still decides who is asking.
- **Queries.** Eight whatever the amount of leave, six without balances: company, departments, leave types
  and the people in scope in parallel; then their leave over the five years, two years of holidays and the
  two balance reads. `tests/integration/reports.test.ts` pins both counts.
- **Charts** are server-rendered HTML in `src/components/charts/` (`MonthColumns`, `YearColumns`, `BarList`,
  `StatTile`; `RunningTotalLines` is an inline SVG stretched to its box, with HTML hover zones and dots), coloured with leave type colours and theme tokens only, with a 2px gap between stacked
  segments and a tooltip on hover. They are hidden from screen readers; the same numbers are in text, a
  "Show as a table" disclosure and the people table.

## Admin (M5)

v1 runs one company per deployment. Every admin use case lives in `src/server/services/admin-*.ts` (people,
departments, leave types, allowances, holidays, company) and `audit-log.ts`, and every one of them:

- starts with `assertCanAdminister(actor)` (`src/domain/admin-permissions.ts`): admins only, refused with
  `forbidden` whatever the page did;
- for writes, re-reads the actor inside the transaction (`assertActiveAdmin`, `src/server/services/admin-access.ts`),
  so an admin demoted or deactivated a moment ago is already refused;
- scopes every query by `actor.companyId`; an id from another company reads as `not_found`;
- writes `audit_log` and an `events_outbox` row in the same transaction (`recordAdminChange`), and records
  nothing when a save changes nothing.

Pages under `/admin/**` call `requireAdminPage()` (`src/app/_lib/page-context.ts`), which answers 404 to
non-admins, and render inside `AdminShell` (`src/app/admin/admin-shell.tsx`). Server actions go through
`adminAction()` (`src/app/admin/admin-action.ts`), the shared action pipeline with the admin role required:
session, admin check, zod parse of the form, one service call through `runActionWith`, then `refresh()`. Next.js server actions only run
for `POST`s whose `Origin` matches the host (see `node_modules/next/dist/docs/01-app/02-guides/data-security.md`,
"Allowed origins"), and Better Auth's session cookie is `SameSite=Lax`, which covers CSRF; no extra token is
needed. Behind a proxy that rewrites `Host`, set `serverActions.allowedOrigins` in `next.config.ts`.

### Locks

Rules that span several people take the **company lock** (`lockCompany`, `FOR NO KEY UPDATE` on the
`companies` row) first: role and active changes (so two admins cannot demote each other past the last-admin
guard), manager changes (so two edits cannot close a reporting loop between them), invites (so the invite limit
counts exactly), leave type creation, archiving and reordering (sort order), and company settings. It is always
the first lock taken, so it cannot deadlock with the member locks taken after it. Allowance overrides take the
person's **member lock** (`lockMember`), as the M3 rule requires of every writer of balance inputs.

### People

- **Invite** (`invitePerson`): creates the `user` row directly (email trimmed, lowercased and checked; name one
  line, 1 to 100 characters; role; department and manager of the same company; self-approval), then, after
  commit, emails a sign-in link. People are never created through Better Auth, whose sign-up stays disabled, so
  access stays invite-only. An email that already has an account, in this company or another, gets one answer
  ("can't be invited"), which says no more about other companies than an admin needs.
- **The sign-in link** comes from Better Auth's own magic-link endpoint, called server-side by
  `issueSignInLink` (`src/lib/auth.ts`): same token table, 15-minute expiry, single use. `sendMagicLink` hands
  the URL back instead of mailing it when the call's `metadata` carries a key that `issueSignInLink` registered
  in process memory (256 random bits, removed straight after; `createLinkCapture` in `src/lib/link-capture.ts`,
  unit-tested against Better Auth's real endpoint). A failed invite link (expired, used) lands on `/sign-in`
  (`errorCallbackURL`), which says so, like the sign-in page's own links. Emails must pass the same rule Better
  Auth's endpoint applies (zod's `z.email()`, copied into `normalizeEmail`), or the invite would create an
  account that can never get a link; the public endpoint's callers control `metadata`
  but cannot guess a live key, so their requests keep the anti-enumeration path (always 200, mail only to active
  people, after the response). The link is issued in the deferred send, after commit, since its account must
  exist first; a failure is logged as `invite_email_failed` with the person's id and never fails the invite. The
  first sign-in marks the email verified. After 15 minutes the invitee asks for a link on the sign-in page, or an
  admin sends one from their page (**Send a new sign-in link**, audited as `user.invite_resent`).
- **Invite limit**: 30 invites and resends per admin per hour, counted from the audit log under the company
  lock (`rate_limited` beyond that), so it holds across restarts.
- **Edit** (`updatePerson`): name, department, manager, role, self-approval. The email is the sign-in identity
  and is not editable. Manager rules (`assertValidManager`, `src/domain/people.ts`): none is fine (an admin
  approves); otherwise an active member of the company, not the person, and not someone who reports to them,
  directly or through others (the walk follows inactive people too, since reactivating one would close the
  loop). A current manager who has since been deactivated stays pickable and is kept when the form is saved
  unchanged; choosing them anew is refused. Approval rights follow the edit at once, in the same transaction
  (`rerouteApprovals`, the same re-routing deactivation uses, below): demoting an admin re-routes the pending
  requests assigned to them (those whose requester they still manage stay with them) and their own pending
  requests; changing someone's manager re-routes that person's own pending requests, so the old manager can no
  longer decide them and the new one sees them; promoting someone to admin re-routes every request an admin had
  routed to themself (below). Each moved request writes `leave_request.reassigned` / `leave.reassigned` and
  emails its new approver after commit; the save message says how many moved.
- **Requests an admin routed to themself.** The approval rule routes an admin's request to themself only while
  they have no active manager and no other active admin exists. Whatever ends that re-routes the request in the
  same transaction: giving them a manager, demoting them, inviting or promoting another admin, or reactivating
  someone (their manager, or an admin). The rule decides where it goes; when it still picks the requester (say,
  their manager is cleared and they are still the only admin) it stays. Decision time checks the same thing, so a
  stale self-assignment never lets an admin approve their own leave (see [Status machine](#status-machine)).
- **Last admin** (`assertKeepsAnActiveAdmin`): no change may leave the company without an active admin
  (`last_admin`). Admins cannot deactivate themselves (`self_change_not_allowed`).
- **Deactivate** (`deactivatePerson`), in one transaction: `is_active = false`; every session deleted (and the
  session hook already refuses new ones); every live calendar link revoked (`calendar_feed.revoked`, reason
  `deactivated`); their own requests untouched. **Pending requests they were assigned to approve are
  reassigned** (`reassignApprover`, `src/domain/approval-rule.ts`): the same rule as at submit minus
  self-approval, so the requester's active manager, else the longest-standing other active admin, else the
  requester if they are an admin, else nobody (`approver_id` null; admins see every pending request anyway).
  Each move is a compare-and-set on `pending` and the old approver, writes `leave.reassigned`, and emails the
  new approver after commit. The reads behind it (requesters, their managers, admins, contacts, leave types) are
  batched, so the company lock is held for a fixed number of reads plus three statements per moved request. Then `user.deactivated`, whose audit `after` counts sessions, links and requests.
  API keys and webhook endpoints they created stay (they belong to the company), but the result counts the live
  ones (`liveApiKeysCreated`, `liveWebhookEndpointsCreated`, by `created_by`) and the screen points the admin
  to Integrations: the person saw each key and signing secret in full.
  Known gap: a request submitted in the same instant can still be routed to the person being deactivated or
  demoted (submit reads the manager and admins without a lock, by design, to avoid deadlocks), and its review
  email may go to them. They cannot decide it (a stored assignment counts only while the approval rule still
  picks its holder, checked at decision time), and it shows in every admin's inbox.
- **Reactivate**: `is_active = true`. Sessions and calendar links do not come back. Requests that moved off them
  while they were away stay where they are, except requests an admin had routed to themself, which are
  re-routed (a returning manager or admin takes them back). Reactivating someone with a scheduled scrub cancels it
  (`user.deletion_cancelled`): only a deactivated person can wait for one.
- **Delete**: the step after deactivating; see [People lifecycle and privacy](#people-lifecycle-and-privacy-m8).
- **Self-approval is per person, not per role.** The handover allowed either. With small teams a per-person
  toggle is a few clicks, and a role-wide setting would be a second source of truth the approval rule would have
  to reconcile with the person's flag (which wins when they disagree?), while a one-off "apply to all managers"
  action would silently change many people at once. The invite form sets it for each new person.

### Departments

Create, rename (unique per company, ignoring case: the service checks first for a calm message, and the unique
index `departments_company_lower_name_uq` on `(company_id, lower(name))`, migration 0008, settles a race) and delete. **A department with anyone in it, active or
not, cannot be deleted** (`department_not_empty`): emptying it would change each of those people with no audit
row of their own. The department row is locked (`FOR UPDATE`) during the delete, so nobody can be moved into it
in between. Departments have no manager: approvals follow each person's manager.

### Leave types

Create (code: uppercase letters, digits, `-` or `_`, at most 12, unique per company; colour `#rrggbb`, `#rgb`
expanded; calendars pick black or white text by contrast, so any colour stays legible), edit, archive, restore
and reorder. Types are never deleted. Archived types leave the request form (`leave_type_unavailable` on submit)
but history and calendars keep them, and so do balances: an archived type shows (marked "archived") on the
dashboard, the admin person page and the allowance editor for any year the person has an allowance row or
approved or pending days of it, so its allowance can still be corrected. The year rollover skips archived types
(no new-year rows, no carryover into a type nobody can book). A restored type goes last. The list is reordered by dragging
(`SortableList`, below), which saves the whole order at once (`reorderLeaveTypes`): it must name every active type
exactly once, or it is refused as `conflict` (the list changed since the page loaded) and nothing moves; the active
types are renumbered 0, 1, 2…, and each type that moved writes `leave_type.reordered`. Balance settings
(counting against allowance, the default, carryover) take effect for every balance computed from then on: balances
are computed, not stored. Changing them does not take everyone's member lock: lowering a default can only make a
remaining go negative, which the M3 rules already allow for a lowered allowance.

### Allowance overrides

`setAllowanceOverride` sets one person's `days` (0 to 366, tenths) and `adjustment_days` (-366 to 366) for one
leave type and year, with a required reason (up to 500 characters). It takes the member lock, upserts the row
(a new one starts with nothing carried), never writes `carried_over_days` itself, and records `allowance.edited`
(the reason in the audit `after`) plus `balance.adjusted` (`reason: "admin_edit"`). Amounts that already match
change and record nothing, and the admin is told so rather than shown "Saved."

Only **last year, this year and later years** can be edited (`firstEditableAllowanceYear`); the page still shows
older years, read-only. The carry out of a year lives in the next year's `carried_over_days`, which only the
rollover computes, and the nightly run closes only last year, so an edit further back would leave every later
carry stale for good. An edit to last year re-runs the rollover's step for that person and type in the same
transaction (`recarryMemberLeaveType`), so this year's carry follows at once (`allowance.carried_over`, actor
`null`). Lowering
below what is booked is allowed; the balance shows "N days over". The person's admin page shows their balances
with the same `summarizeBalances` the dashboard uses.

### Holidays

List by year (2000 to 2100), add (one per date), rename, delete, and add the eleven US federal holidays for a
year on their observed dates (`usFederalHolidays`, `src/domain/holidays.ts`: Saturday → Friday, Sunday → Monday,
so a Saturday New Year's Day belongs to Dec 31 of the year before), skipping dates that already have one. Adding
or deleting holidays recounts the requests on those dates in open years
([Recount after a calendar change](#recount-after-a-calendar-change)); the confirmation says how many were
recounted, how many now take no days, and who is now over a balance. Renaming changes no count.

### Company

Name, time zone, working days and allowance policy. Time zones are those in `Intl.supportedValuesOf("timeZone")`
plus `UTC` (which that list omits); a stored zone outside the list (an alias saved before this check) is kept
when unchanged but cannot be chosen anew. Working days: at least one ISO weekday. The policy must be registered
(`ALLOWANCE_POLICY_KEYS`; only `annual_calendar_year` today). New working days recount open requests
([Recount after a calendar change](#recount-after-a-calendar-change)); a new time zone only moves "today". Since M8 the page
also holds the deletion grace option ([The grace option](#the-grace-option)); `company.updated` carries it as
`deletionGrace`.

### Appearance

`/admin/appearance` (`updateCompanyAppearance`): the theme everyone in the company sees, an optional accent colour
and a corner style, all chosen by an admin (never per person; light or dark is per person, above). Themes are a fixed list (`THEMES` in
`src/domain/appearance.ts`); each keeps one accent colour. The root layout reads the look on every request
(`getAppearance`, which falls back to the default on any error so a page never fails on it) and sets `data-ui`,
`data-corners` and, for a custom accent, the accent tokens on `<html>`. `globals.css` keys each theme's tokens
(colours, fonts, radii, shadows) on those attributes; fonts are self-hosted from `@fontsource-variable` packages,
and a browser downloads only the ones the chosen theme uses (Admin → Appearance previews every theme, so that
page loads them all). A pale custom accent keeps its fill and gets a darker
`--accent-ink` for text and focus rings (`accentTokens`). Only `classic` with its own accent has a dark version
(`followsDarkMode`): there each person's colour mode applies (`data-mode`, above); every other look is light only for
now, whatever the person chose, and the account page says so. The same page sets how Home asks for time off
(`requestStyle`): the labelled form, or one editable sentence (`RequestLeaveSentence`). Both post the same fields to
the same action and share the live preview (`useLeaveDraft`, `LeavePreviewLine`), so the choice changes nothing but
the layout. The root layout, the account page and Home read the appearance once per request
(`requestAppearance`, `src/app/_lib/appearance.ts`). It also sets a layout trial (`layout`: `standard`, `tonal`, `grouped`, `compact` or `legible`, see `LAYOUTS`), which
the root layout puts on `<html>` as `data-layout` (left off for `standard`). Each trial is a block of CSS rules in
`globals.css` keyed on that attribute and on the `app-page`, `app-header` and `app-nav` hooks that `AppPage` and `AppHeader`
carry: it changes spacing, shape, type size, surface treatment and navigation, never content or actions. Colours
stay derived from the theme (a tinted card or ground, a darker grey for text on it), so an admin can try one on the
whole company and switch back.
`company.updated` carries `theme`, `accentColor`, `corners`, `requestStyle`, `layout` and `logo`.

The same page sets the company's logo (`updateCompanyLogo`, `removeCompanyLogo`). The file is judged by its bytes,
never its name or claimed type (`readLogoImage`, `src/domain/company-logo.ts`): PNG or JPEG only, up to 512 KB and 4096
pixels a side. SVG is refused because it can carry script and Outlook draws neither SVG nor WebP. The bytes live on the
company row (`companies.logo`, with its SHA-256, type and size beside it; a check keeps the five set or cleared together),
so no file store is needed on any host. `GET /logo/<sha256>.<png|jpg>` serves it publicly, like the favicon, because the
sign-in page and emails show it before anyone signs in. The URL names the content, so a hit is cached for a year, and
it is sent with its own `Content-Type`, `nosniff` (so a browser never guesses another type) and `Content-Security-Policy: default-src 'none'` (so even opened directly it can load or run nothing). The header and sign-in page show it instead of the OOOhm logo
(`getCompanyLogo` and `getDeploymentLogo`, which never fail a page), and every email puts it at the top at its absolute
URL (`emailAccent` with `appUrl`), sized with attributes so Outlook keeps its shape. A change is a `company.updated` event
whose `logo` describes the file.

### Audit log viewer

`/admin/audit` (`getAuditLog`): a `DataTable`, one line a change (when, what, about whom, by whom), each row opening to the full time and every field changed. Newest first, or oldest (the When header), 25, 50 or 100 a page, read-only. A `TableToolbar` across its top holds the search, a Filters panel and the filters in force as removable chips; everything applies as it changes (the search after a pause in typing, an option at once, a date when its field is left). Clicking an action or a person in a row narrows the log to it. The search matches each word against action labels and people's names and emails in the app, then reads with the matching ids (`action in …` or `actor_id in …` or `subject_user_id in …`, every word), so the database never scans text. Filters: action (from the known list),
who did it, who it is about (`subject_user_id`), and a date range in the company's time zone (converted in SQL
with `date::timestamp at time zone <zone>`, so day boundaries follow DST). Malformed filters are ignored. Each row
says who or what made it with `changeSourceLabel` ("Ana", "Ana, via Gusto sync", "System: year rollover"); the
"who did it" filter matches `actor_id`, so it finds a person's changes whether direct, through a sync or with one of
their API keys.

- **Keyset pagination** on `(created_at, id)`, both ways (see Long lists): the key carries `created_at` printed in
  UTC to the microsecond, because a JS `Date` keeps only milliseconds and would skip or repeat rows written in the same one.
- **Indexes** (migration `0007`): `audit_log_company_created_idx (company_id, created_at, id)` and one per
  filter, `(company_id, action | actor_id | subject_user_id, created_at, id)`, so a page reads about 25 index
  entries in order instead of sorting the company's log. `audit-log.test.ts` checks the plan.
- **Five queries a page**, whatever it holds: company (time zone), people, departments and leave types in
  parallel (for the pickers and for naming ids inside before/after snapshots), then the page, whose actor and
  subject names, and API key name and prefix, come from joins. Adapter names come from the registry.
- Summaries are pure (`describeAuditChange`, `src/domain/audit.ts`): changed fields only, ids named ("Manager:
  Ana → Ben"), an unknown id described rather than shown.

### Screens

`/admin` opens People. A sub-nav (People, Departments, Leave types, Holidays, Company, Audit log, and since M6
Integrations, which opens Webhooks and adds a quieter second row of tabs for Webhooks, API keys and Connectors)
sits under the header, which shows **Admin** to admins only. One main action per screen (Invite someone, Save changes, Add
…); secondary actions are quiet text buttons, and destructive ones (deactivate, delete, archive) ask first.
Per-row edits (rename, change an allowance) open in place. Refused saves keep what was typed (forms submit
without React's automatic reset) and show the reason with `role="alert"` in `errorText` (`text-danger`).

## People lifecycle and privacy (M8)

A person moves through at most three states, each a deliberate admin action (`src/server/services/admin-people.ts`,
`src/server/services/admin-people-deletion.ts`; rules in `src/domain/person-deletion.ts`):

| State | How | Signs in | Shows in People | Reversible |
| --- | --- | --- | --- | --- |
| Active | Invite | Yes | Yes | |
| Deactivated | **Deactivate** ([People](#people)) | No | With **Show inactive** | Yes: **Reactivate** |
| Deleted (tombstone) | **Delete…** on a deactivated person | No | Never | No |

There is no "archived" state. The People list hides deactivated people unless **Show inactive** is ticked
(`?inactive=1`), and never lists a tombstone, nor do pickers (managers, the audit log's filters), the team view,
calendars, feeds or `GET /api/v1/users`. History views (the audit log, approvals, a request's approver) name a
tombstone by its tombstone name.

### The two deletes

| | Full scrub (`scrubbed`, the default) | Keep records (`records_kept`) |
| --- | --- | --- |
| Tombstone name | "Former employee #3f9a2c" (`tombstoneName`: the id's first six letters or digits) | "<Name> (deleted)" |
| Email | `deleted+<id>@invalid` (`tombstoneEmail`) | same; the real address is free to invite again |
| Sessions, linked accounts (Google), unused sign-in links to their address, calendar feed links | deleted | deleted |
| Their leave requests (and per-year days), allowance rows | deleted | kept; a request still pending is withdrawn (`cancelled`) |
| Audit rows about them (`subject_user_id`, or their `user` entity) | deleted, except the one new `user.deleted` row | kept |
| Their name in stored payloads | replaced by the tombstone name | kept |
| Their email in stored payloads | replaced by the placeholder | replaced by the placeholder |
| Records where they acted on someone else (approvals they made, audit rows with them as `actor_id`) | kept, shown as "Former employee #…" | kept, shown as "<Name> (deleted)" |
| API keys and webhook endpoints they created | kept: they belong to the company (`created_by` points at the tombstone) | same |

The `user` row is **never removed**: every foreign key to it (approvals, audit actors, API keys) keeps pointing at
the tombstone. `user.deleted_at` and `user.deletion_mode` (migration `0012`) mark it; `user_deletion_shape` requires
both or neither, and a tombstone can never be active. Its role becomes employee, and its manager, department,
self-approval and image are cleared, so it holds up nothing (a department with a tombstone in it can still be
deleted). Re-inviting the released address creates a brand-new person with nothing linking them to the tombstone.

**Payload redaction** (`redactStoredMentions`): every company row whose text mentions the person (a `strpos` scan,
then a precise rewrite) in `events_outbox.payload` (and so what adapters are handed, which read the outbox),
`webhook_deliveries.body` and `last_response_excerpt` (delivered, failed and pending alike), `adapter_deliveries.last_error`,
`import_runs` (`report`, `counts`, `source_file_name`), the remaining `audit_log.before`/`after`, leave
requests' `note` and `decision_note`, and the labels admins give company settings: API key names, webhook endpoint
descriptions, and department, leave type and holiday names (never an endpoint's URL, which says where it sends). The
rules (`PersonRedaction`, `redactText`, `redactJson`):

- **The email** is replaced wherever it stands as a whole address, in both modes: not where it is only part of a
  longer one, so deleting `ed@acme.com` leaves `ted@acme.com`, `fred.ed@acme.com` and `ed@acme.com.au` alone, byte
  for byte, but after the separators of a URL, query string or log line (`/users/ed@acme.com`, `?email=ed@acme.com`)
  it is theirs. Object keys lose the email and nothing else.
- **On a full scrub, the `name` field of their own records** (an object whose own `userId`, else `email`, is theirs:
  `user.*` payloads, person snapshots, import report rows) becomes the tombstone name, whatever name it holds, so a
  name from before a rename goes too. The `name` field of anyone else's record is kept bar the email (deleting one
  "Sam Lee" never renames the other Sam Lee).
- **On a full scrub, free text** (every other string: notes, an admin's reason on a colleague's allowance row, import
  messages, the name of a thing such as an API key or holiday) loses each **full name** they are known to have had,
  as whole words, ignoring case and spacing (two spaces or a line break between the words too): the current name plus
  earlier ones read from their `user.*` events and the audit snapshots of their account before those go
  (`listOwnNameRecords`, `namesInOwnRecords`). Only names of two or more words are searched for: a one-word name
  ("May", "Will") is too often an ordinary word to rewrite other people's text for, so "May Day" stays when a "May"
  is deleted. Nor is a name **another person of the company also goes by** (anyone not deleted, or deleted with their
  records kept, by the name before " (deleted)"; `listOtherNames`, `nameInUse`): the text cannot say which of them it
  means, so the other Sam Lee's notes, and everyone's mentions of "Sam Lee", stay as written.

The lookup needles are the email and the longest word of each of those names (as written and JSON-escaped), plus, on
a scrub, the person's id, which finds their own records whatever name they hold. One word rather than the whole name,
because the rewrite allows any spacing between the words, which no single substring covers; the rewrite then changes
only what matches. A **pending** delivery is sent with its redacted body; one whose body cannot be redacted safely
(not JSON, or still holding the address afterwards) is stopped for good: `failed`, `last_error = 'subject_deleted'`.
A delivery **in flight** under a lease when the delete commits (webhook or adapter) has its attempt count moved on
(`rewriteDelivery`, `supersedeAdapterAttempts`), so the attempt's outcome loses its compare-and-set and is dropped,
and the delivery goes again, redacted, once the lease runs out.

**Keeping records withdraws** the person's own requests still waiting for a decision (status `cancelled`), so none
sits in Approvals for someone who is gone or holds up deleting the approver it waited on. The withdrawal is part of the
delete: counted in its one audit row (`pendingRequestsWithdrawn`), with no `leave.cancelled` event of its own.

### Rules, locks and the record

- Only a **deactivated** person can be deleted (two steps, so nobody is deleted by accident). They must **manage no
  one** and have **no pending requests to decide**; the **last-admin guard** still applies (it only ever adds to "still
  active", since only an active admin holds a seat). Anything that blocks comes back as `deletion_blocked` with
  the blockers as its `details` (`stillActive`, `reports` with names, `pendingApprovals`, `lastAdmin`;
  `deletionBlockersOf`), and the dialog shows what to sort out first, with links to the people they manage, instead
  of the form. A refusal that arrives after the page loaded (something changed in between) brings the current
  blockers, and the dialog switches to them in place.
- A tombstone is not a member: `lockMember` and `lockPerson` read it as missing, so nothing (an allowance edit posted
  with its id, say) can be written for it. `GET /api/v1/balances?userId=<tombstone>` returns no rows for a scrubbed
  person, and the kept balances of someone deleted with their records kept.
- The admin types the person's **full name** (case and spacing aside; the email when the name is blank), or
  `confirmation_mismatch`.
- Everything for one delete runs in **one transaction**: the company lock first, then the person's member lock
  (`lockPerson`), so it serialises with every other admin change, with balance writers, and with a second delete. The
  grace option is the only deferred path.
- Every delete writes **exactly one audit row** (`user.deleted`, subject and entity the tombstone, `before` null,
  `after` `{ mode, counts }` with counts only) and **one event** (`user.deleted`, `{ userId, mode, deletedAt }` plus
  `actorId`/`actor`). Neither holds a name or email.

### The confirmation and the export

`getDeletionPreview` counts from the database what each mode removes ("Deletes 14 leave requests, 3 years of
balances, 41 audit entries", `describeDeletion`). The dialog (`src/app/admin/people/delete-person-dialog.tsx`, a
native modal `<dialog>`) offers the two modes as radios with the full scrub preselected, the counts, **Download their
records first**, the type-the-name field, small print on the limits below, and a destructive button that stays off
until the name matches.

**Download their records first** is `GET /admin/people/<id>/export` (a route handler, `exportPersonRecords`): one CSV
with a `record` column (`leave_request`, `balance`, `audit`): their requests with notes, their balance per leave type
for every year they have an allowance row or booked days (computed by the dashboard's balance code), and the audit
entries about them as the viewer words them (`listAuditEntriesAbout`: the names load once, then a thousand rows per
query, at most the newest 10,000). Admins of the person's company only (anyone else, another company's id or a
tombstone: a bare 404), `Cache-Control: no-store`, a file name by short id (never the name), cells that look like a
formula prefixed with `'` (`src/domain/csv.ts`). Each download is audited as `user.records_exported` (an audit row
and no event: nothing changed). Being a GET that writes and hands out personal data, it refuses a request another
site started (`Sec-Fetch-Site` other than `same-origin` or `none`; `isCrossSiteRequest`) with a 404, so a link
elsewhere cannot make a signed-in admin's browser download it. A full scrub deletes the export's audit row with the
rest of their audit rows.

### The grace option

**Company → Wait 7 days before a full scrub, with undo** (`companies.deletion_grace`, off by default). With it on, a
full scrub only schedules: `user.scrub_scheduled_at = now + 7 days` and `scrub_requested_by` = the admin
(`user_scrub_schedule_shape`: only a deactivated, undeleted person can be scheduled), audited as
`user.deletion_scheduled`. The person is already deactivated and cannot sign in. People and the person's page say
"Scheduled for deletion on <date> · Undo"; **Undo** (`cancelScheduledDeletion`) clears it as
`user.deletion_cancelled`, and so does reactivating them. The `scheduled_scrub` daily job (worker, cron route, inline
tick and embedded timer alike; [Scheduled jobs](#scheduled-jobs)) runs each due scrub in its own transaction under the
same locks, after re-checking the rules: one they now refuse (say a request was routed to them in a race) is logged
as `scheduled_scrub_blocked`, stays scheduled for the next run, and is passed over (the job pages on past it, up to
500 checks a run), so it never holds up the scrubs due after it. The person's page then says "Deletion was due on
<date>, but it can't run yet" with what blocks it. Since the job runs daily, a scrub happens within a day after its
date. Asking for a full scrub again while one is scheduled changes nothing (the dialog offers only keeping records,
and says the date it already has). Keeping records never waits, and replaces a scheduled scrub.

### What is not erased

These limits are also the dialog's small print:

- **Webhooks already delivered** to other systems cannot be recalled. `user.deleted` (mode `scrubbed`) tells
  integrations to erase their own copy.
- **Backups** keep the data until they rotate out, after the configured retention: `deploy/backup.sh` keeps
  `RETENTION_DAYS` days, 30 by default (any whole number is accepted, with a warning on every run above 30;
  [hosting.md](hosting.md#backups-bound-how-long-deleted-data-survives)); on Vercel, the database provider's (Neon's)
  restore window.
- **A downloaded CSV** is outside OOOhm.
- Free text that names them only partly (a first name in someone else's note) is not detected; the full name and the
  address are. A person known by a one-word name, or by a name someone else in the company also has, is not searched
  for in free text at all (their own records still lose it). A webhook endpoint's URL is never rewritten.
- Pseudonymous history stays after a full scrub: events about their requests keep ids and dates under the tombstone
  id until retention prunes delivered events (90 days); `user.deleted` carries the id so integrations can match it.
- A webhook or adapter attempt **already in flight** when the delete commits sends what it already read; its outcome
  is dropped and the delivery is sent again, redacted.

## Integrations (M6)

Three ways for other systems to follow and read OOOhm, all fed by the events outbox: signed **webhooks**, the
read-only **REST API** (`/api/v1`), and **adapters** (none ship in v1). The public reference for integrators is
[docs/api.md](api.md); this section is how it works inside.

```
service tx ─► events_outbox ──(worker: dispatch)──► webhook_deliveries ──(worker: deliver)──► POST, signed
                   │                          └───► adapter_deliveries ──(worker: deliver)──► adapter.deliver()
                   └──(GET /api/v1/events: replay)
```

### Outbox → dispatch → deliveries

Every state change already writes an `events_outbox` row in its transaction (`recordChange`). The **outbox
worker** (`scripts/worker.mts`, `pnpm worker`, the compose `worker` service) turns those rows into deliveries:

1. **Dispatch** (`dispatchOutboxBatch`, `src/server/services/outbox-dispatch.ts`). In one transaction: claim up
   to 100 undispatched rows, oldest first, with `FOR UPDATE SKIP LOCKED`; create a `webhook_deliveries` row for
   every enabled, live endpoint of the event's company that subscribes to its type and **existed when the event
   was written** (an endpoint never receives history); create an `adapter_deliveries` row for every registered
   adapter whose `handles(type, companyId)` is true (a throw counts as false and is logged as
   `adapter_handles_failed`, so a faulty adapter cannot stall dispatch); set `delivered_at` (read it as "dispatched"). The delivery's `body` is
   the envelope as JSON, fixed now so every retry sends the same bytes. Unique `(endpoint, event)` and
   `(adapter, event)` indexes make a repeat harmless.
2. **Deliver** (`deliverDueWebhooks`, `src/server/services/webhook-delivery.ts`). Claim up to 20 due deliveries
   (`status = 'pending' and next_attempt_at <= now`, enabled live endpoint) in one `UPDATE ... WHERE id IN
   (SELECT ... FOR UPDATE SKIP LOCKED)` that also **leases** them: `attempts + 1`, `next_attempt_at = now + 2
   min`. Then, 8 at a time and outside any transaction: open the endpoint's secret, sign, POST with a 10-second
   timeout, and record the outcome with a compare-and-set on `(id, attempts, status = 'pending')`. A worker that
   dies mid-attempt leaves the lease to run out and the next claim retries it, so delivery is **at least once**;
   a late outcome from a superseded claim (or after a redelivery) is dropped. Adapter deliveries
   (`deliverDueAdapterEvents`) work the same way with a 30-second limit per `deliver` call, but run one after
   another and are **claimed one at a time**, just before each call, so the 2-minute lease always covers the one
   call it guards: a slow adapter never leaves queued claims whose leases run out and get re-claimed by another
   worker while the first is still working through its batch.
3. **Retry schedule** (`retryDelayMs`, `src/domain/integrations.ts`, shared): after attempt 1 to 7 fails, wait
   1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h, each ±10% jitter; the 8th failure marks it `failed`. Success is a
   2xx. Anything else is a failure: other statuses (3xx included: redirects are never followed), timeouts,
   refused or blocked addresses, an unreadable secret (`secret_unreadable`, e.g. after the key changed).

Statuses: `pending` (not tried yet, waiting to retry, or in flight under a lease), `delivered`, `failed`,
`cancelled` (its endpoint was deleted). A disabled endpoint gets no new deliveries, and the claim skips its
pending ones, which go out when it is turned back on.

Several workers are safe at once: every claim is `SKIP LOCKED` (no event dispatched twice, no worker waiting on
another) or a compare-and-set. `webhook-delivery.test.ts` runs two dispatchers and two deliverers concurrently
over 40 events and checks every event is dispatched and sent exactly once, and that a dispatcher passes over
rows another transaction holds instead of waiting.

### The worker process

Four loops share a pool of 5 connections: dispatch, deliver (webhooks), adapters (adapter deliveries), and jobs
(each minute). Each loop runs one step of `runTick` (below), the same code the cron route and the app run. Adapters get their own loop so a slow or hanging adapter (up to 20 calls of 30 seconds in one
pass) never holds up webhook delivery. A loop that found work goes again at once; an idle one sleeps `WORKER_POLL_INTERVAL_MS` (1 s), doubling to
`WORKER_MAX_IDLE_MS` (10 s). A loop error is logged (`worker_loop_failed`) and the loop backs off; it never exits.
`SIGTERM`/`SIGINT` stops the loops: no new batch or claim starts; webhook attempts in flight finish (at most the
10-second timeout, under compose's 30-second `stop_grace_period`) and the unstarted rest of their batch is released
(`releaseDeliveryClaims`: due at once, attempt not counted); an adapter call in flight sees its
`AdapterContext.signal` abort and its delivery is released the same way (`releaseAdapterClaim`), as is one
claimed just as the stop landed, whose adapter is then never called. A shutdown therefore never spends an
attempt or turns a last attempt into `failed`; an interrupted call may have reached the other system, so it is
sent again (at least once). Then the pool closes (`worker_stopped`). A
second signal exits at once; anything in flight is retried after its lease.

It reads its own environment (`src/lib/worker-env.ts`), not the app's: `DATABASE_URL`, `WEBHOOK_ENCRYPTION_KEY`,
`WEBHOOK_ALLOW_INSECURE`, `WEBHOOK_ALLOW_PRIVATE`, `LOG_LEVEL`, `WORKER_POLL_INTERVAL_MS`, `WORKER_MAX_IDLE_MS`.
Compose gives it exactly those (no auth, OAuth or SMTP secret), and its `ServiceContext` refuses to send mail or
issue sign-in links. Compose also runs it as the unprivileged `node` user on a read-only filesystem with no
capabilities. **This keeps secrets out of its environment; it is not database isolation.** The worker connects as
the same owner role as the app, so a compromised worker could read or write any table, including Better Auth's
`session` and `verification` rows. A dedicated role granted only the outbox, delivery, endpoint and rollover
tables (and nothing on `session`, `account` or `verification`) is the next step if that matters to a
deployment; v1 does not ship one. Log lines are structured (`log`) and carry ids, event types, status codes and short error
codes, never a URL, secret, signature or body (`webhook-delivery.test.ts` checks).

### Scheduled jobs

`runDueJobs` (`src/server/services/scheduled-jobs.ts`) runs the daily jobs: `year_rollover` (the M3
`runYearRollover`), `integration_retention` and `scheduled_scrub` (`runDueScrubs`, full-scrub deletes whose grace
period has ended; see [People lifecycle](#people-lifecycle-and-privacy-m8)). A worker claims a job with an atomic compare-and-set on its
`scheduled_jobs` row (`UPDATE ... SET next_run_at = now + 1 h WHERE name = $1 AND next_run_at <= now`): of
several workers exactly one gets it, and, unlike a session advisory lock, the claim survives restarts, so a job
runs once a day however often workers restart. Success sets `next_run_at` a day after the claim; a failure is
logged and recorded (`last_error`: error name and code only, since a query error's message carries parameters)
and retried an hour later; a crash leaves the one-hour lease to run out. Every job is idempotent (a scrub re-checks,
under its locks, that the person is still scheduled and due), so the rare overlap after an expired lease is harmless.

**Retention** (`pruneIntegrationData`): finished webhook and adapter deliveries last changed more than 90 days
ago, then dispatched outbox events written more than 90 days ago (unless an adapter still has one pending), in
batches of 1,000. Pending deliveries and undispatched events are never pruned. The audit log is never pruned.

### Webhooks

Admin use cases are in `src/server/services/webhooks.ts`, screens under `/admin/webhooks`. They follow the admin
rules ([Admin](#admin-m5)): `assertCanAdminister`, `assertActiveAdmin` in the transaction, company scoping (an id
from another company, or a deleted endpoint, is `not_found`), and `audit_log` + outbox in the same transaction.

- **Create** takes the company lock and allows at most 20 live endpoints per company (`limit_reached`), since
  every event fans out to each. The URL is checked (`normalizeWebhookUrl`, `src/domain/webhook-target.ts`):
  absolute, at most 2,048 characters, no credentials or fragment, `https:` unless `WEBHOOK_ALLOW_INSECURE`
  (`insecure_url`), and, unless `WEBHOOK_ALLOW_PRIVATE`, not an IP literal in a blocked range nor an obviously
  local name such as `localhost`, `*.local`, `*.internal` or a single label (`blocked_address`). Event types must
  come from `WEBHOOK_EVENT_TYPES` (every outbox type, grouped for the form; `ping` is never subscribable).
- **The secret** is `whsec_` and 32 random bytes, generated in the service, returned once (shown with a copy
  button by `RevealForm`, `src/components/forms/reveal-form.tsx`), and stored sealed with AES-256-GCM under
  `WEBHOOK_ENCRYPTION_KEY` (`createSecretBox`, `src/lib/integration-crypto.ts`): a fresh 12-byte IV per seal, a
  16-byte tag, and the **endpoint id as additional data**, so a sealed value copied onto another row does not
  open. `v1.<iv>.<ciphertext>.<tag>` leaves room for a key rotation scheme later. It is encrypted, not hashed,
  because the signer needs the plaintext.
- **Rotate** replaces the secret at once; every later attempt, retries of older events included, uses the new
  one. There is no overlap window (decision: one secret keeps verification simple; the header format already
  allows several `v1=` values if a grace period is added).
- **Disable/enable**, **delete** (soft: `deleted_at`, `enabled = false`, pending deliveries `cancelled`), **ping**
  (a `ping` delivery to that endpoint only, refused when it is off) and **redeliver** (a finished delivery back to
  `pending` with `attempts = 0`, same event id and body, refused while pending) are queued for the worker: the app
  never makes an outbound request. Each is audited.
- **Audit and events** hold the URL's origin only (`urlOrigin`), never its path or query. An edit that changes the
  URL also records `urlChanged: true`, so a move to another path on the same host is visible. Not a hash of the
  URL: an unkeyed hash of a path holding a short token could be brute-forced by anyone who reads events.

**Signing** (`webhookRequestHeaders`): `OOOhm-Event-Id`, `OOOhm-Event-Type`, `OOOhm-Timestamp` (unix seconds at
the attempt) and `OOOhm-Signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)>`. The receiver's steps
and a Node snippet are in [docs/api.md](api.md#verifying-the-signature); `verifyWebhookSignature` implements the
same, and the unit tests pin the HMAC against a vector computed with `openssl dgst -hmac`.

**Server-side request forgery.** The worker's transport (`createSafeFetch`, `src/lib/safe-fetch.ts`) is Node's
`http`/`https`, not `fetch`, so it controls name resolution: its `lookup` resolves **every** address of the host
and refuses the connection if any is blocked (`isBlockedAddress`), on the very answer the socket then uses, so
DNS rebinding between a check and the connection is impossible. IP literals are checked before connecting (Node
skips `lookup` for them). Blocked: IPv4 0/8, 10/8, 100.64/10, 127/8, 169.254/16 (cloud metadata), 172.16/12,
192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4; IPv6 `::`,
`::1`, `100::/64`, `2001::/32` (Teredo), ORCHID, `2001:db8::/32`, `fc00::/7` (incl. AWS `fd00:ec2::254`),
`fec0::/10`, `fe80::/10`, `ff00::/8`; and any IPv4-mapped, -compatible, NAT64 or 6to4 address whose embedded IPv4
is blocked. Anything that does not parse is blocked. Redirects are never followed, the response body is read up
to 64 KB, and only a 200-character excerpt is stored.

### REST API

Route handlers under `src/app/api/v1/*/route.ts` are one line each: `apiGet` (`_lib/api-get.ts`) builds the
context, then `handleApiRequest` (`_lib/handler.ts`, injectable and tested without Next) authenticates, rate
limits and maps errors; the route parses the query with zod (`_lib/query.ts`) and calls one service in
`src/server/services/api-v1.ts`, whose queries are in `src/server/repositories/api-reads.ts` and the existing
repositories.

- **Keys** (`src/server/services/api-keys.ts`, screen `/admin/api-keys`): `ooohm_` + 32 random bytes, shown once,
  stored as SHA-256 hex under a unique index (a plain hash suffices for 256 random bits) with an 8-character
  `prefix` for admins to tell keys apart. At most 50 live keys per company. `scopes text[]` is `CHECK`ed to
  `read`/`write`; v1 grants `read` and every endpoint requires it (`assertScope`), so `write` endpoints can come
  later without a migration. Creating and revoking are audited with `api_key.*` events, never the key or hash.
  Keys belong to the company: deactivating the admin who made one does not revoke it.
- **Authentication** (`authenticateApiKey`): only a well-formed `Authorization: Bearer ooohm_<43>` is looked up,
  by its hash (one index probe), then compared again with `timingSafeEqual`. Missing, malformed, unknown and
  revoked keys get the same 401. `last_used_at` is written at most once a minute per key.
- **The client** is an `ApiClient` (`keyId, companyId, scopes`), the API's counterpart of `Actor`: every query is
  scoped by its `companyId`, never by input. Ids of another company read as absent.
- **Rate limits** (in process memory, like the feed's): 120 requests a minute per key (429, `Retry-After: 60`),
  and 30 requests without a valid key per client address (`clientAddress`), after which they get 429 instead of
  401; a valid key is never refused by the second. One standalone server process makes this exact; several
  instances would each count separately.
- **Pagination** is keyset, `limit + 1` rows to know whether a next page exists: `/users` by `id`
  (`user_company_id_idx (company_id, id)`), `/leave-requests` by `(start_date, id)`
  (`leave_requests_company_start_id_idx`), with the calendar's lower bound on `start_date` when `from` is given.
  Cursors are base64url JSON the service validates (`400` otherwise).
- **Fixed query counts** (pinned in `api.test.ts`): 2 per page of users, leave types, leave requests or events
  (the key, then the page), 3 for events after a cursor and for holidays, 6 for balances (the key; settings, types
  and people; allowance rows and booked days), however many rows.
- **No notes.** Leave requests never include the requester's note or the decision note: the M4 privacy rule, and
  a key is a company-wide machine credential.
- **Errors** are `{ error: { code, message } }` (`invalid_request`, `unauthorized`, `forbidden`, `rate_limited`,
  `internal_error`); every response is `Cache-Control: no-store`.
- **OpenAPI 3.1** is hand-written in `_lib/openapi.ts` and served at `/api/v1/openapi.json` (public).
  `api.test.ts` walks `src/app/api/v1` and fails if a route method is undocumented or a documented one does not
  exist.

**Event replay** (`GET /api/v1/events`) pages the outbox after an event id. Ordering by `created_at` alone would
lose events: a transaction that writes early but commits late would land behind a reader's cursor. So every
outbox row stores the id of the transaction that wrote it (`tx_id`, `pg_current_xact_id()`, migration 0009), the
replay orders by `(tx_id, created_at, id)` (`events_outbox_company_tx_idx`), and returns only rows with
`tx_id < pg_snapshot_xmin(pg_current_snapshot())`: rows of transactions older than every transaction still
running. Any row a reader could see later then has a larger `tx_id` and sorts after its cursor. Read-only
transactions (`pg_dump`, reports) take no transaction id and do not hold it back; a transaction that writes and
stays open does, until it ends. `api.test.ts` holds a writing transaction open and checks that neither its row nor
a later committed one shows, and that both arrive after the cursor once it commits.

### Adapters

`src/server/integrations/adapter.ts` defines the seam; `installed.ts` lists what a deployment registers, and is
**empty in v1** (`adapters.test.ts` and the unit tests assert it).

```ts
interface Adapter {
  id: string;                                   // stable; stored with each delivery
  displayName: string;
  handles(eventType: string, companyId: string): boolean;  // outbound filter, per company
  deliver(event: EventEnvelope, ctx: AdapterContext): Promise<void>;   // outbound; throw to retry
  syncUsers?(ctx: AdapterContext): Promise<InboundUser[]>;            // inbound
  syncBalances?(ctx: AdapterContext): Promise<InboundBalance[]>;      // inbound
  healthCheck(ctx: AdapterContext): Promise<{ ok: boolean; detail?: string }>;
}
```

Adapters are registered per deployment, but every call is for one company: `handles` gets the `companyId`, and
every `AdapterContext` carries it. An adapter that a company must connect first (credentials, an opt-in) answers
`false` from `handles` for companies that have not, so per-company installation needs no change to dispatch; its
configuration (say an `adapter_installations` table read through a new `AdapterContext` field) is the part a
first real adapter adds.

Adapters never touch the database (lint enforces it: `src/server/integrations/**` may not import the pool,
schema, Drizzle, `env`, `auth`, services or repositories). Outbound, the worker delivers envelopes to them
exactly as to webhooks (`adapter_deliveries`, same claim, lease and retry schedule; a delivery whose adapter is
no longer registered fails its attempts with `adapter_not_registered` and resumes if it comes back). Inbound,
`applyInboundSync` (`src/server/services/inbound-sync.ts`) writes what they return:

- **People**, matched by lowercased email, in one transaction under the company lock: a person of this company is
  renamed if the name differs (`user.updated`); an unknown email creates an employee with no department or
  manager (`user.created`), **inactive** unless the caller passes `activateNewUsers`; an email of another company,
  or a malformed entry, is skipped and reported. Invite-only holds: a sync creates the row and nothing else (no
  session, link or email), and an inactive person cannot sign in until an admin reactivates them.
- **Allowances** by email, leave type code and year, each in its own transaction under the person's member lock
  (`lockMember`), through `writeAllowance`, the same write as an admin's override: `days` and `adjustment_days`
  (kept when omitted), never `carried_over_days`, last year and later only, last year re-carried at once.
  `allowance.synced` + `balance.adjusted` (`reason: "sync"`).
- Every change is attributed by the caller's `SyncTrigger`: the admin who pressed **Sync now**
  (`syncAdapterNow`), via `adapter_sync:<id>`, or the system process `adapter_sync:<id>` for a scheduled sync
  ([Attribution](#attribution-who-or-what-made-a-change)). The audit snapshot also keeps `source: "adapter:<id>"`.

`/admin/integrations` (**Integrations → Connectors**; the admin nav groups webhooks, API keys and connectors under one **Integrations** link with a second row of tabs) lists registered adapters with their `healthCheck` (5-second limit each, failures shown as
"not connected" and logged) and a **Sync now** action for those that sync; in v1 it shows a calm empty state
pointing at webhooks and API keys. `adapters.test.ts` proves the seam with a test-only adapter: outbound delivery
with a failure, a scheduled retry and success; failure after 8 attempts; inbound people and allowances with audit
and events.

To add one: implement `Adapter` in `src/server/integrations/adapters/<name>.ts` and list it in `installed.ts`.
Nothing else changes. Configuration and credentials per company are not modelled yet; the first real adapter
will add them to `AdapterContext`, not to core code.

## Import from TimeOff.Management (M7)

A one-time importer, run from the command line (`pnpm import:timeoff`, `scripts/import-timeoff.mts`). The
runbook and the mapping rules are in [import.md](import.md); this is how it is built.

```
SQLite file ──(readTimeOffSqlite, node:sqlite, read-only)──► TimeOffSnapshot ──(buildImportPlan, pure)──► ImportPlan
                                                                                                          │
                     report ◄──(reconcile: loadBalances)◄── one transaction ◄──(importTimeOff)────────────┘
```

- **Reader** (`src/server/importers/timeoff/sqlite-reader.ts`): opens the file with Node's built-in `node:sqlite`
  (Node 22.13+, no native dependency) read-only and returns plain records (`src/domain/timeoff/source.ts`). Table
  and column names are matched against the spellings TimeOff's Sequelize models have used; a missing required one
  stops the import with what the file does have.
- **Plan** (`src/domain/timeoff/mapping.ts`, pure): people (email dedupe, roles, managers from department bosses,
  loop breaking), departments, leave types (the allowance pool decision), holidays, allowance rows, requests (half
  days split into single-day requests, days counted with OOOhm's `splitLeaveDaysByYear`), and TimeOff's own
  balance for every person and year (`src/domain/timeoff/balance.ts`). Refusals are `DomainError("import_refused")`.
- **Service** (`src/server/services/timeoff-import.ts`): one `db.transaction` for everything, with bulk writes from
  `src/server/repositories/imports.ts`. It runs the year rollover's step for last year
  (`recarryMemberLeaveType`, with a `record` hook that audits each change as `import.allowance` instead of the
  rollover's `balance.adjusted` event) for every imported active person, so the reconciliation sees what the
  nightly job will leave, then compares through `loadBalances` (the dashboard's balance code). Pending requests
  are routed by `reassignApprover(new ManagerApprovalRule(), ...)` over the imported organisation, so they land in
  the manager's inbox; decided ones keep TimeOff's decider. The plan counts leave against the target company's
  existing holidays plus TimeOff's, so a holiday only OOOhm has shows as a mismatch. A dry run, or an `--apply` with
  a current-year mismatch, throws a private `RollBack` carrying the report out of the transaction callback, so
  Drizzle rolls back and the caller still gets the report.
- **Ledger**: `import_runs` (migration 0011) records each committed import with the file's SHA-256 (unique), its
  counts and the full report; the same file is refused afterwards.
- **Audit and outbox**: every imported row gets an `audit_log` row (`import.*` actions, `IMPORT_AUDIT_ACTIONS`,
  attributed to the `--actor` admin via `timeoff_import`; see [Attribution](#attribution-who-or-what-made-a-change)),
  written in bulk by `insertAuditEntries(tx, source, entries)`, which writes no outbox event. This is the one place
  where a state change is audited without its own event: the import announces itself with a single
  `import.completed` (`IMPORT_EVENT_TYPES`, counts and hash only) instead of replaying the imported history to
  webhooks. See [api.md](api.md#types-and-payloads-version-1).
- **Invite-only**: people are inserted as rows only (`insertImportedAccounts`); no session, account link,
  verification token or email. Active people sign in through the normal magic link.
- **CLI-only**: `importTimeOff` takes no `Actor` (there is no session); it resolves `actorEmail` (`--actor`) to an
  active admin of the target company inside the transaction, after people are imported, and refuses otherwise.
  That names who made the change; it is not a sign-in, since whoever runs the CLI already holds the database
  credentials. The lint rules forbid `src/app` from importing it or `src/server/importers/*`.

## Hosting: database and background modes

OOOhm does not assume a host. The supported setups and what each needs are in [hosting.md](hosting.md); Peter's
instance runs on Vercel with Neon ([deploy-vercel.md](deploy-vercel.md)). This is how the code makes that work.

### Database modes

`resolveDatabaseConfig` (`src/db/config.ts`, pure) decides from the environment, and `src/db/connect.ts` opens what it
names; the app (`src/db/index.ts`), every script, the worker and the test harness go through these two, so pooler,
pool-size and embedded handling cannot differ between them.

- **Postgres** (`DATABASE_URL=postgres://...`, any Postgres 15+). postgres.js honours `sslmode` and the other URL
  parameters. A transaction pooler (Neon's `-pooler` host, Supabase's port 6543, or `DATABASE_POOLER=transaction`)
  gets `prepare: false`, since each transaction may land on another server connection. On a serverless host (`VERCEL`
  or `DATABASE_SERVERLESS=true`) the pool is 3 connections with a 20-second idle timeout (`DATABASE_POOL_MAX`
  overrides). Migrations connect to `DATABASE_URL_UNPOOLED` when set: DDL and the migrator want a real session.
- **Embedded** (`OOOHM_DB=embedded`, or `DATABASE_URL=pglite:<dir>`): PGlite (Postgres 18 compiled to WebAssembly)
  with drizzle's `pglite` driver, data in `OOOHM_DATA_DIR` (default `./data/pglite`). PGlite and that driver are
  imported at run time only in this mode, with `webpackIgnore`, so they are neither bundled nor traced into the
  Docker image or a Vercel function (`drizzle-orm` is a server external, so the app and the driver share one copy).
  `src/instrumentation.ts` opens and migrates it before the server takes a request; until then `db` refuses. It is
  single-process: every opener first creates `<dir>.lock` exclusively with its pid (`src/db/embedded-lock.ts`), and
  another process (the worker, a script) fails naming the holder; a lock whose process has gone is taken over.

The `Database` type is the driver-neutral `PgDatabase`. The query builder behaves the same on both drivers; what a raw
`execute()` returns does not (postgres.js: an array of rows; PGlite: `{ rows }`), so the three statements the builder
cannot express (the `UPDATE ... FROM ... SKIP LOCKED` delivery claims, the retention deletes) go through
`executeRows` (`src/db/rows.ts`). Driver errors differ too: `violatedConstraint` (`src/server/repositories/errors.ts`)
reads postgres.js's `constraint_name` and PGlite's `constraint` behind drizzle's wrapper.

What embedded mode needed checking, and how each behaves on PGlite (`pnpm test:integration:embedded` runs every
integration test on it):

| Feature | On PGlite |
| --- | --- |
| `FOR UPDATE SKIP LOCKED`, `FOR NO KEY UPDATE` | Accepted. With one connection, transactions run one at a time, so there is never a locked row to skip or wait for: the claims stay correct, trivially |
| `pg_current_xact_id()`, `pg_snapshot_xmin(pg_current_snapshot())` (the `/events` replay) | Work. With no concurrent writer, every committed row is below the snapshot's xmin, so the replay sees everything committed, in order |
| `clock_timestamp()`, `gen_random_uuid()`, jsonb, partial indexes, check constraints, `EXPLAIN` | Work unchanged |
| Advisory locks | Work (OOOhm uses none; row locks serialize instead) |
| Concurrent transactions | Serialized by PGlite's single connection. Races the tests stage (two submits, two decisions) resolve as they do on a server, one after the other. Two tests that hold a lock on one connection while another works are skipped there (`needsServer`): "SKIP LOCKED passes over held rows" and "events written by a transaction still open never appear behind a cursor" |

### Background modes

Background work is one function, `runTick` (`src/server/services/background-tick.ts`): a bounded pass that
dispatches outbox events, delivers due webhook deliveries, then due adapter deliveries, then runs a due daily job
(and delivers what that job wrote), each step repeating while it finds work and the budget lasts (`OOOHM_TICK_BUDGET_MS`,
15 s). When the budget runs out no new work starts; webhook attempts in flight finish (10 s at most) and an adapter
call in flight is cut short and released, exactly as on a worker shutdown. Every claim underneath is `SKIP LOCKED` or
a compare-and-set, so ticks are safe to run concurrently, repeatedly, and beside workers (`background-tick.test.ts`
runs three at once over eight events: each dispatched and sent once).

Who calls it is `OOOHM_BACKGROUND` (`src/lib/background-mode.ts`):

- `worker` (the default; compose sets it): `scripts/worker.mts` runs each step in its own loop.
- `inline` (the default on Vercel and in embedded mode): **after a transaction that wrote outbox events commits**,
  the services' after-commit seam (`inTransaction` and `commitThenNotify` in `src/server/services/notify.ts`, which every
  service the app calls goes through to record a change) calls `ctx.defer(ctx.wake)`. `recordChange` marks the transaction that wrote an event,
  so a refused or rolled-back change, or a read, wakes nothing. In the app `defer` is `after()`, so the tick runs after
  the response and Vercel keeps the function alive for it (`waitUntil`); it never blocks or fails the request, and an
  error is logged (`background_tick_failed`). Emails are queued before the wake, so mail never waits on a webhook.
  `src/instrumentation-node.ts` registers `wake` at start-up; a per-process scheduler (`createTickScheduler`) folds
  requests made during a tick into one more pass instead of running ticks side by side.
- `cron`: only `GET /api/cron/tick` runs it.

`GET /api/cron/tick` (`src/app/api/cron/tick`) works in every mode: `Authorization: Bearer <CRON_SECRET>` compared
in constant time on SHA-256 digests (`isCronAuthorized`), a bare 401 otherwise (and always while `CRON_SECRET` is
unset, logged as `cron_secret_unset`), the tick's counts as JSON with `Cache-Control: no-store`, `maxDuration` 60.
`vercel.json` calls it daily (Hobby's limit). In embedded mode the app also runs a tick every
`OOOHM_TICK_INTERVAL_SECONDS` (30) from an unref'd timer started in `register()`, Node.js runtime only and never
during `next build`; that timer is what sends retries and runs the daily jobs there.

Ticks run with `backgroundContext()`: `defer` runs at once (there is no request for `after()`), and `wake` is unset, so
a tick never wakes another.

**Rate limits** stay in process memory (`src/lib/rate-limit.ts`). On one server they are exact; on Vercel each
instance counts separately, so they are approximate. The submit limit is counted in the database and holds anywhere.

### Migrations per host

`pnpm db:migrate` everywhere; compose runs it in `migrate`, embedded mode also on start. On Vercel the `vercel-build`
script runs `scripts/migrate.mts --if-production && scripts/seed.mts --if-production && next build`: migrations run
only when `VERCEL_ENV` is `production`, over `DATABASE_URL_UNPOOLED`, and a failure fails the build, so new code never
goes live on an old schema. The seed then runs only on a production build with `SEED_ADMIN_EMAIL` set and no company
yet, so it creates the first admin once and later builds skip it (`SEED_ON_DEPLOY=force` overrides for one deploy). Preview builds never migrate or seed; keeping previews off the production database is a deployment setting
([deploy-vercel.md](deploy-vercel.md#2-keep-previews-away-from-the-production-database)).

Every environment value is trimmed when read (`nonEmptyEnv`), so a secret stored with a trailing newline (the
`echo value | vercel env add` mistake) still works in OOOhm.

## Production deployment (M7)

`deploy/docker-compose.prod.yml` runs the same images as development behind Caddy (`deploy/Caddyfile`): automatic
HTTPS, security headers, compression, a body size limit and access logs without query strings or feed tokens.
Only Caddy publishes ports; Postgres sits on a network Caddy is not on. The app runs with `TRUSTED_PROXY_HOPS=1`.
`deploy/backup.sh` and `deploy/restore.sh` dump and restore the database (custom-format `pg_dump`, gzipped), with a
systemd timer in `deploy/systemd/`. After each nightly run no local backup is older than `RETENTION_DAYS` (30 by default; `find
-mmin`, since `-mtime +30` let files live 31 to 32 days), and the documented off-site hook prunes to the same limit:
backup retention is what bounds how long a deleted person's data survives ([hosting.md](hosting.md#backups-bound-how-long-deleted-data-survives)). The runbook is [deploy.md](deploy.md).

## Testing

| Command | What | Needs |
| --- | --- | --- |
| `pnpm test` | Unit tests in `tests/unit/` (domain rules incl. manager loops and the last-admin guard, settings validation, allowance policy, year split, federal holidays, calendar grid, ICS writer, audit summaries, change sources and their labels, email templates, formatting, TimeOff's balance rules and the import mapping, which read a synthetic TimeOff SQLite file built at test time; the hosting pieces: database and background-mode configuration, pooler detection, trimmed env values, the embedded directory lock, the cron route's authorization and the tick scheduler; the past-year cancel rule; deleting people: tombstone names and emails, the guards, the confirmation, payload redaction and CSV escaping) | nothing |
| `pnpm test:integration` | Service tests in `tests/integration/` against real Postgres, including every admin service (happy path, non-admin refused, another company's ids not found, audit and outbox rows) and the audit viewer's paging, filters, query count and plan; the integration layer: dispatch fan-out, two concurrent workers, retries and backoff on a fake clock and transport, redelivery, ping, rotation, API auth, rate limits, pagination, company scoping, query counts, OpenAPI coverage, the adapter seam, scheduled jobs and retention; the TimeOff import: dry run untouched, apply reconciled to zero, re-run refused (same file, or any later export into an imported company, even with `--force`), the fixture carried forward to a later year reconciling, mismatch rolled back, admin guard, non-empty company, the `--actor` admin (unknown or non-admin refused with nothing written), audit rows and the single `import.completed` attributed to that admin via `timeoff_import`; past-year leave refused for the requester and an admin, in the company's time zone, including an imported 2025 request; the background tick: inline after a change (and not after a refused one), a due retry, three ticks at once, the budget, daily jobs; deleting people (`person-deletion.test.ts`): both modes (exactly which rows go and stay, the counts in the one audit row, the one `user.deleted` event), every guard, the grace option (scheduled, undo, the daily job, attribution), re-inviting a released address, a kept-records delete withdrawing their pending request, outbox, delivery, import and settings-label redaction including a pending delivery that must not leak and one in flight when the delete commits, a namesake untouched (free text included), the CSV export, and a no-trace scan of every text, varchar, json(b) and text[] column of every table (read from `information_schema`, so new tables are covered) for the name parts and email after a full scrub | `TEST_DATABASE_URL` |
| `pnpm test:integration:embedded` | The same suites on embedded PGlite (`TEST_DATABASE_URL=pglite:memory`: an in-memory database per file, migrated as embedded mode migrates). Two tests that need two connections at once are skipped (`needsServer`) | nothing |

The unit suite also covers the integration layer's pure parts (HMAC vector, headers and verification, backoff,
IPv4/IPv6 range checks including mapped forms, URL rules, envelope, encryption round trip and tamper detection,
API key format) and runs the webhook transport against a local HTTP server (loopback refused by literal and by
name, no redirects, 64 KB cap, timeout). `tests/e2e/` holds a signature-verifying webhook receiver and a setup
script for trying the whole flow against a real build ([docs/api.md](api.md#try-it-locally)), a writer for the
synthetic TimeOff file (`timeoff-fixture.mts`, [docs/import.md](import.md#try-it-locally)), and `explain-queries.mts`,
which seeds two companies of 50 people with three years of leave into an empty migrated database, runs the
dashboard, calendar, approvals, admin and REST API services, and prints each statement they send with its
`EXPLAIN ANALYZE` plan, flagging sequential scans of the large tables. At M7 every read path sent a fixed number of
statements (no N+1) and none needed a new index: the only sequential scans were on `leave_request_days` and
`leave_requests` where the planner preferred them for small tables or for company-wide balance sums.

Both run with Node's test runner through `tsx --conditions=react-server`. The `react-server` condition makes
`import "server-only"` resolve to its empty module, the same way Next.js resolves it on the server, so tests
can import server modules (for example the logger) unchanged. `tsx` also resolves the `@/` path alias.

Integration tests: point `TEST_DATABASE_URL` at a Postgres 17 server where the user may create databases.
Each test file creates `ooohm_test_<random>`, runs the Drizzle migrations from `drizzle/`, and drops it at
the end, so files run in parallel without sharing state. Without the variable the suites are skipped with a
message. A throwaway server:

```bash
docker run -d --rm --name ooohm-test -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55502:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55502/postgres pnpm test:integration
docker stop ooohm-test
```

The harness gives tests driver-neutral helpers: `t.query` (raw SQL as a tagged template), `t.withLogger` (a second
handle that counts queries) and `t.migrate`. `t.client` (postgres.js itself) is only for the tests skipped on PGlite.

Tests build a `ServiceContext` whose mailer records messages and whose `defer` queue runs only on
`ctx.settle()`, mirroring `after()`: emails are asserted after commit, not before. Tests assert outcomes
(rows, events, recipients, which request won a race) rather than the presence of guards.

A data migration is tested by migrating a copy of `drizzle/` that stops before it, inserting rows, then
applying the rest (`tests/integration/migrations.test.ts`, via `createTestDatabase({ migrationsFolder })`).
The rollover runs across every company in its database, so `rollover.test.ts` keeps to its own file and
database.

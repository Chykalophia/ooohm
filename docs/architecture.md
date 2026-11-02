# OOOhm architecture

OOOhm is one Next.js app (App Router) over one Postgres database. The code is layered so that the rules
that matter (who approves what, how days are counted, which status changes are legal) live in plain
TypeScript that can be tested without a browser, a server or a database.

## Layers

Dependencies point downward only. A layer never imports from one above it. `pnpm lint` enforces this table
with per-directory `no-restricted-imports` rules in `eslint.config.mjs`; change both together. Those rules match
import specifiers, so imports across directories use the `@/` alias and a parent-relative (`../`) import is a
lint error everywhere under `src/`. `src/server/email/**` (templates) and `src/server/context.ts` (the
`ServiceContext` type) sit just below services: no Next.js, database, schema, Drizzle, `env`, `auth`, services or
repositories. `src/server/integrations/**` (the adapter seam, M6) follows the same rules. `src/server/runtime.ts` is
the composition root and imports no service or repository. `scripts/*.mts` (migrate, seed, rollover, the outbox
worker) are composition roots for processes outside Next: each builds its own `ServiceContext`.

| Layer | Path | Owns | May import |
| --- | --- | --- | --- |
| Presentation | `src/app/**` | Pages, layouts, client components, server actions, route handlers | services, `@/server/runtime`, domain types, constants and pure functions, `lib` |
| Application (services) | `src/server/services/**` | Use cases, transactions, data-dependent authorization, audit + outbox writes, post-commit email | repositories, domain, `@/server/context`, `@/server/email`, `lib` (not `env`, `db`, `auth`) |
| Data access (repositories) | `src/server/repositories/**` | Drizzle queries only. Every function takes an executor (`db` or `tx`) first | `@/db/schema`, `@/db/types`, domain types |
| Domain | `src/domain/**` | Pure types, rules and policies. No I/O, no Next.js, no Drizzle, no env | nothing outside `src/domain` |
| Infrastructure | `src/lib/**`, `src/db/**` | Env, logging, mail transport, auth, formatting, schema, the connection pool | `domain` (pure functions and types, e.g. `toActor` for `requireActor`) |

Rules of thumb:

- **Pages and actions are thin.** Parse input with zod, call `requireActor()`, call one service function, map
  the result to UI. No Drizzle in `src/app`.
- **Services own the transaction.** A service opens `db.transaction`, re-reads what it needs inside it, checks
  permissions against that data, writes, and records the change. Email is returned from the transaction
  callback and sent by `commitThenNotify` after commit, so a rolled-back change never emails anyone.
- **Repositories have no rules.** They take ids that the service already scoped to the actor's company.
- **The domain decides.** `ManagerApprovalRule`, `countLeaveDays`, the status state machine and the
  permission checks are pure functions with unit tests.

### Composition root

Services receive a `ServiceContext` (`src/server/context.ts`): the database handle, a mailer, a `defer`
function, the app's base URL, a clock, `issueSignInLink` (makes a one-time sign-in link without sending it,
for invites), and, since M6, `secrets` (seals webhook secrets), `webhookTargets` (the URL policy) and `adapters`
(the adapter registry). The app builds the real one in `src/server/runtime.ts` (`db`, nodemailer, `after()` from
`next/server`, `BETTER_AUTH_URL`, Better Auth's magic-link endpoint, `WEBHOOK_ENCRYPTION_KEY`, the
`WEBHOOK_ALLOW_*` flags, the installed adapters); the worker builds its own in `scripts/worker.mts`. Tests build
theirs against a throwaway database. This keeps services free of Next.js and of the app's environment.

## Cross-cutting conventions

### Actor and authorization

`requireActor()` (`src/lib/auth.ts`) returns the session user and an `Actor` (`id`, `companyId`, `role`,
`canSelfApprove`, and `source`: how they are acting, recorded on every change they make; see
[Attribution](#attribution-who-or-what-made-a-change)). Every service that acts for a person takes the `Actor`. `company_id` always comes from the
actor, never from input, and every query is scoped by it. A request id from another company is
indistinguishable from one that does not exist (`not_found`).

`actor` is `null` for a user not yet attached to a company; pages show a calm "ask an admin" message.

### Errors

Expected failures throw `DomainError` with a stable `code` (`src/domain/errors.ts`). Server actions run
service calls through `runAction` (`src/app/run-action.ts`), which maps each code to a calm message and logs
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

#### Attribution: who or what made a change

Nothing is anonymous. Every change names a `ChangeSource` (`src/domain/change-source.ts`), one of:

| `kind` | Who or what | Example label in the audit log |
| --- | --- | --- |
| `user` | A person, directly, or through something they started (`via`) | "Peter Krzyzek", "Peter Krzyzek, via Gusto sync" |
| `api_key` | A person's API key: the key's creator and the key, optionally `via` something | "Peter Krzyzek, via API key ‘Zapier’ (ooohm_ab12cd34…)" |
| `system` | A process with no person behind it (`process`) | "System: year rollover", "System: scheduled Gusto sync" |

`via` and `process` share one vocabulary of stable identifiers: `year_rollover`, `retention`, `adapter_sync:<adapterId>`,
and `timeoff_import` (reserved; nothing writes it yet). They are stored and published, so never rename one.
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

Storage (`audit_log`, migration `0010`): `actor_kind` (`user` | `api_key` | `system`, not null), `actor_id` (the
person), `api_key_id` (FK to `api_keys`, `set null`), `actor_via`, `actor_process`. A `CHECK` requires a `system` row
to name a process and nobody; a `user` row has no key or process; an `api_key` row has no process. **A person's row
does not require `actor_id`**: the foreign key is `on delete set null`, and a check that required it would make
deleting a `user` row fail. OOOhm never deletes people (it deactivates them), and the TypeScript types require the
id on every write, so in practice it is always set; if a row is ever deleted, its changes stay a person's
(`actor_kind = 'user'`) and the viewer says "A deleted person". No name is copied into the log, so deleting a person
does erase who made those changes.

Migration `0010` backfilled older rows: a row with `actor_id` became `user`; one without, `system`, with
`process` `year_rollover` for `allowance.carried_over` and `allowance.created` (only the rollover's step wrote those
without an actor), `adapter_sync:<id>` for the inbound sync's rows (identified by `after.source = "adapter:<id>"`
on `user.*` rows and `after.reason = "Synced from adapter:<id>"` on `allowance.synced`; with an actor, that becomes
the actor's `via` instead), and `unknown` for anything else.

Every event payload publishes the same source as **`actor`** (added within version 1), next to `actorId`, which
stays the person or `null` for compatibility: `{ type: "user", id, via? }`, `{ type: "api_key", id, apiKeyId,
via? }` (`id` is the key's creator) or `{ type: "system", process }`. `recordChange` writes both from `source`,
so an event and its audit row can never disagree.

Leave events (`src/domain/events.ts`) are a public contract for webhooks and adapters (M6):

| Event | When | `status` in payload |
| --- | --- | --- |
| `leave.requested` | Every submit, including self-approved ones | `pending` |
| `leave.approved` | An approver or admin approves, or self-approval at submit | `approved` |
| `leave.rejected` | An approver or admin declines | `rejected` |
| `leave.cancelled` | The requester cancels a pending or approved request | `cancelled` |

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
the event type, and `actorId` is the admin.

| Event | When | Payload (v1) |
| --- | --- | --- |
| `user.created` | An admin invites someone | `userId, email, name, role, departmentId, managerId, canSelfApprove, isActive, actorId`: the person after the change |
| `user.updated` | An admin changes name, department, manager, role or self-approval | same |
| `user.deactivated` | An admin deactivates someone | same |
| `user.reactivated` | An admin reactivates someone | same |
| `user.invite_resent` | An admin sends someone a new sign-in link | same |
| `department.created`, `.renamed`, `.deleted` | | `departmentId, name, actorId` (the name before, on `deleted`) |
| `leave_type.created`, `.updated`, `.archived`, `.unarchived`, `.reordered` | | `leaveTypeId, code, name, color, isPaid, countsAgainstAllowance, defaultAllowanceDays, carryoverEnabled, carryoverMaxDays, sortOrder, archived, actorId` |
| `holiday.created`, `.renamed`, `.deleted` | | `holidayId, date, name, actorId` |
| `company.updated` | | `companyId, name, timezone, workingDays, allowancePolicy, actorId` |

One more event comes with M5 but is not an admin event: it is `LEAVE_REASSIGNED_EVENT_TYPE`, outside
`ADMIN_EVENT_TYPES`, and its audit `action` follows the leave request actions instead of the event type.

| Event | When | Audit `action` | Payload (v1) |
| --- | --- | --- | --- |
| `leave.reassigned` | A pending request moves to another approver: its approver was deactivated or demoted from admin, the requester's manager changed, or someone was invited as admin, promoted to admin or reactivated who can now take a request an admin had routed to themself (actor = the admin) | `leave_request.reassigned` | the `leave.*` payload plus `previousApproverId, approverId` (either may be `null`) |

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

[docs/api.md](api.md#events) is the public catalogue of every type and payload, with the envelope they are
delivered in.

### Dates

Leave dates are `YYYY-MM-DD` strings end to end (`date` columns in `mode: "string"`). Arithmetic runs on UTC
epoch days in `src/domain/calendar-date.ts`, and display formatting (`src/lib/format.ts`) formats in UTC, so
a stored day never shifts with the server's or browser's time zone. "Today" is computed in the company's
time zone (`todayInTimeZone`).

### Email

Notification emails (`src/server/email/leave-emails.ts`) have fixed subjects. Names, notes and reasons go in
the body only (HTML-escaped there), never in a header; names are also collapsed to one line of at most 100
characters. People cannot rename themselves (Better Auth's `/update-user` is disabled), since a name reaches
approvers' inboxes and emails. Sends run after commit (`after()` in the app), each in
its own try/catch; failures are logged as `leave_email_failed` with the request id and email kind, never the
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
      refused.
   3. Refuses an overlap with the requester's own pending or approved requests. A morning and an afternoon
      half day on the same date do not overlap.
   4. Refuses (`insufficient_balance`) when a tracked leave type's balance cannot cover the request in any
      year it touches. See [Balances](#balances-m3).
4. Resolves the approver with `ManagerApprovalRule` and stores `approver_id`.
5. Inserts as `pending` with `days` = the total, stores the per-year split in `leave_request_days`, and records
   `leave.requested`. If the rule says self-approve, it immediately moves to `approved` (`decided_at` = now,
   approver = requester) and records `leave.approved`. Self-approved requests are held to the same balance.

### Approval rule

`ApprovalRule` (`src/domain/approval-rule.ts`) is pluggable; v1 ships `ManagerApprovalRule`:

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
request. Any admin of the company, or the assigned approver, may approve or reject a pending request, with an
optional reason (max 500 characters) stored in `decision_note`. Every status change is a compare-and-set
(`UPDATE ... WHERE status = <expected>`), so of two concurrent decisions exactly one wins and the other gets
`conflict`.

**A stored assignment grants the right to decide only while it still matches the approval rule** (`canDecide`,
`src/domain/leave-permissions.ts`). When the right rests on the assignment (a non-admin approver, or an admin
deciding their own request routed to themself), `decideLeaveRequest` reads the requester, their manager and the
active admins in the same transaction and asks `reassignApprover` who should decide now; anyone else gets
`forbidden` and the request is left to the admins, who see every pending request. Its compare-and-set then also
requires `approver_id` to still be the actor, so it loses (`conflict`) to a concurrent re-route. This closes the
window a submit leaves open: submit reads the manager and the admins without locking them (a shared lock on the
approver would bring back the deadlock between two people who approve each other, see step 2 of
[Submitting](#submitting)), so a submit racing a deactivation or demotion can still store an approver that the
admin change meant to remove. Nothing re-routes that request, and its review email may have gone to the
person just removed; but they cannot decide it, and every admin sees it in their inbox. Admins deciding someone
else's request skip the check (no extra reads).

### Emails

| Transition | Recipients |
| --- | --- |
| Requested (routed) | Approver (not when it is the requester) |
| Requested (self-approved) | Requester gets "approved"; no review email |
| Approved | Requester, with the approver's note if they wrote one |
| Rejected | Requester, with the reason |
| Cancelled | Requester, plus the approver unless the approver is the person cancelling |

Inactive recipients are skipped. Links use `BETTER_AUTH_URL` as the app's base URL.

### Screens

- `/` (dashboard): the request form (the one primary action) with its live preview, the person's balance per
  active leave type for the current year, and their own requests with a two-step cancel. A decision note shows under approved and declined requests. Defaults: first active leave type by
  sort order, the first working day (not a holiday) from today in the company's time zone (`nextWorkingDay`),
  end = start, full day.
- `/approvals`: pending requests the person can decide (assigned to them; admins see every pending request
  in the company, each marked with who it is assigned to), earliest dates first, each with Approve / Decline
  and an optional reason the requester sees either way. At most 100 show at once, with a note giving the full
  count when there are more. The header links here for managers, admins, and anyone with something
  currently assigned to them.

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
to `leave_requests.days`, which stays the total. Balances only ever read these rows, so editing holidays or
working days later never changes a past balance. Rejected and cancelled requests drop out because balances
sum only `pending` and `approved` requests.

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
(`aria-describedby`): "This is 3 days. You'll have 12 days left for 2026.", or the exact message submit would
give ("That's 5 days, but you only have 2 days left for 2026.", "Those dates are all weekends or holidays...").
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
- `/team?month=YYYY-MM&department=<id>`: "who's out". Every active member of the company with approved or
  pending leave that costs at least one working day of the month (`entriesCostingDaysIn`: a Thursday-to-Sunday
  request belongs to the Thursday's month, not to the month holding only its weekend), grouped by person (by name), each person's leave by date, pending marked
  "Waiting for approval". Department filters are links ("Everyone", then each department); an id that is not a
  department of the actor's company falls back to everyone. Deactivated people do not appear.
- `/calendar/subscriptions`: the two feeds (below), linked from both pages.

The header links Calendar and Team for every member of a company. No `proxy.ts` gates routes: each page calls
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

Every member may see who is out, when, and the leave type's name and colour. Nobody sees another person's request
note, decision note or balance on any calendar screen or feed. This is enforced by shape, not by filtering: every
calendar view and both feeds are built from `CalendarEntry` (`src/domain/calendar.ts`), and the repository's
calendar queries (`src/server/repositories/calendar.ts`) select only its fields. Notes are left out of the personal
feed too, since a feed URL can travel further than the app. A person with a blank name is labelled by the part
of their email before the `@` (`teamLabel`, `src/domain/person.ts`), never the full address, on the team view
and in the team feed. Emails, which go only to the requester and their approver, still fall back to the full
address (`personLabel`).

### Feed tokens

`calendar_feed_tokens (id, company_id, user_id, kind personal|team, token_hash, created_at, last_used_at,
revoked_at)`, migration `0005`.

- A token is 32 random bytes in base64url (43 characters), from `src/lib/feed-token.ts`. Only its SHA-256 (hex,
  `CHECK`ed) is stored, under a unique index; the lookup is one index probe on the hash. A plain hash suffices
  because the input is 256 random bits, not a password.
- The link is shown once, in the server action's response, and never again: OOOhm keeps no copy. The page then
  shows only when the feed was created and last fetched.
- "Get a new link" revokes the live link and issues a new one in one transaction; "Turn off" sets `revoked_at`.
  Both run under the person's member lock, and a partial unique index (`user_id, kind` where `revoked_at is
  null`) backs it up, so one person never has two live links of a kind. Each change writes `audit_log` and
  `events_outbox` rows in the same transaction.
- Listing, regenerating and turning off match the person and kind, not the person's current company, like the
  unique index. A link issued before a company move is listed, revoked by "Get a new link" or "Turn off", and its
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

Pages under `/admin/**` call `requireAdminPage()` (`src/app/admin/admin-shell.tsx`), which answers 404 to
non-admins. Server actions go through `adminAction()` (`src/app/admin/admin-action.ts`): session, admin check,
zod parse of the form, one service call through `runAction`, then `refresh()`. Next.js server actions only run
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
  re-routed (a returning manager or admin takes them back).
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
(no new-year rows, no carryover into a type nobody can book). A restored type goes last. Reorder moves one place up or down,
then renumbers the active types 0, 1, 2…; each type that moved writes `leave_type.reordered`. Balance settings
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
so a Saturday New Year's Day belongs to Dec 31 of the year before), skipping dates that already have one. As M3
fixed, a submitted request keeps its stored day split, so holiday changes never move a past balance; the page says
so.

### Company

Name, time zone, working days and allowance policy. Time zones are those in `Intl.supportedValuesOf("timeZone")`
plus `UTC` (which that list omits); a stored zone outside the list (an alias saved before this check) is kept
when unchanged but cannot be chosen anew. Working days: at least one ISO weekday. The policy must be registered
(`ALLOWANCE_POLICY_KEYS`; only `annual_calendar_year` today). Changes affect future counting only.

### Audit log viewer

`/admin/audit` (`getAuditLog`): newest first, 50 a page, read-only. Filters: action (from the known list),
who did it, who it is about (`subject_user_id`), and a date range in the company's time zone (converted in SQL
with `date::timestamp at time zone <zone>`, so day boundaries follow DST). Malformed filters are ignored. Each row
says who or what made it with `changeSourceLabel` ("Ana", "Ana, via Gusto sync", "System: year rollover"); the
"who did it" filter matches `actor_id`, so it finds a person's changes whether direct, through a sync or with one of
their API keys.

- **Keyset pagination** on `(created_at, id)`: the cursor carries `created_at` printed in UTC to the
  microsecond, because a JS `Date` keeps only milliseconds and would skip or repeat rows written in the same one.
- **Indexes** (migration `0007`): `audit_log_company_created_idx (company_id, created_at, id)` and one per
  filter, `(company_id, action | actor_id | subject_user_id, created_at, id)`, so a page reads about 50 index
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
without React's automatic reset) and show the reason with `role="alert"` in `text-red-700 dark:text-red-400`.

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
(each minute). Adapters get their own loop so a slow or hanging adapter (up to 20 calls of 30 seconds in one
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
`runYearRollover`) and `integration_retention`. A worker claims a job with an atomic compare-and-set on its
`scheduled_jobs` row (`UPDATE ... SET next_run_at = now + 1 h WHERE name = $1 AND next_run_at <= now`): of
several workers exactly one gets it, and, unlike a session advisory lock, the claim survives restarts, so a job
runs once a day however often workers restart. Success sets `next_run_at` a day after the claim; a failure is
logged and recorded (`last_error`: error name and code only, since a query error's message carries parameters)
and retried an hour later; a crash leaves the one-hour lease to run out. Both jobs are idempotent, so the rare
overlap after an expired lease is harmless.

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
  button by `RevealForm`, `src/app/admin/reveal-once.tsx`), and stored sealed with AES-256-GCM under
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

## Testing

| Command | What | Needs |
| --- | --- | --- |
| `pnpm test` | Unit tests in `tests/unit/` (domain rules incl. manager loops and the last-admin guard, settings validation, allowance policy, year split, federal holidays, calendar grid, ICS writer, audit summaries, change sources and their labels, email templates, formatting) | nothing |
| `pnpm test:integration` | Service tests in `tests/integration/` against real Postgres, including every admin service (happy path, non-admin refused, another company's ids not found, audit and outbox rows) and the audit viewer's paging, filters, query count and plan; the integration layer: dispatch fan-out, two concurrent workers, retries and backoff on a fake clock and transport, redelivery, ping, rotation, API auth, rate limits, pagination, company scoping, query counts, OpenAPI coverage, the adapter seam, scheduled jobs and retention | `TEST_DATABASE_URL` |

The unit suite also covers the integration layer's pure parts (HMAC vector, headers and verification, backoff,
IPv4/IPv6 range checks including mapped forms, URL rules, envelope, encryption round trip and tamper detection,
API key format) and runs the webhook transport against a local HTTP server (loopback refused by literal and by
name, no redirects, 64 KB cap, timeout). `tests/e2e/` holds a signature-verifying webhook receiver and a setup
script for trying the whole flow against a real build ([docs/api.md](api.md#try-it-locally)).

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

Tests build a `ServiceContext` whose mailer records messages and whose `defer` queue runs only on
`ctx.settle()`, mirroring `after()`: emails are asserted after commit, not before. Tests assert outcomes
(rows, events, recipients, which request won a race) rather than the presence of guards.

A data migration is tested by migrating a copy of `drizzle/` that stops before it, inserting rows, then
applying the rest (`tests/integration/migrations.test.ts`, via `createTestDatabase({ migrationsFolder })`).
The rollover runs across every company in its database, so `rollover.test.ts` keeps to its own file and
database.

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
repositories. `src/server/runtime.ts` is the composition root and imports no service or repository.

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
function, the app's base URL and a clock. The app builds the real one in `src/server/runtime.ts`
(`db`, nodemailer, `after()` from `next/server`, `BETTER_AUTH_URL`). Tests build their own against a
throwaway database. This keeps services free of Next.js and of the app's environment.

## Cross-cutting conventions

### Actor and authorization

`requireActor()` (`src/lib/auth.ts`) returns the session user and an `Actor` (`id`, `companyId`, `role`,
`canSelfApprove`). Every service that acts for a person takes the `Actor`. `company_id` always comes from the
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

Every state change calls `recordChange(tx, { audit, event })` (`src/server/repositories/change-log.ts`) in
the same transaction as the change. It takes a `Transaction`, not the pool, so it cannot be called outside
one. `audit_log.created_at` and `events_outbox.created_at` default to `clock_timestamp()`, so rows written in
one transaction (e.g. `leave.requested` then `leave.approved` for a self-approved request) keep their order.

Leave events (`src/domain/events.ts`) are a public contract for webhooks and adapters (M6):

| Event | When | `status` in payload |
| --- | --- | --- |
| `leave.requested` | Every submit, including self-approved ones | `pending` |
| `leave.approved` | An approver or admin approves, or self-approval at submit | `approved` |
| `leave.rejected` | An approver or admin declines | `rejected` |
| `leave.cancelled` | The requester cancels a pending or approved request | `cancelled` |

Payload (v1): `requestId, userId, leaveTypeId, startDate, endDate, dayPortion, days, status, actorId`. Add
fields; never rename or remove one.

Balance events (M3):

| Event | When | Audit `action` |
| --- | --- | --- |
| `balance.adjusted` | The year rollover sets a carried-over amount (`reason: "carryover"`) | `allowance.carried_over` |
| `balance.adjusted` | The year rollover creates an allowance row from the leave type default, or copies it from the person's latest row for a type without a default (`reason: "allowance_created"`) | `allowance.created` |

Payload (v1): `allowanceId, userId, leaveTypeId, year, days, carriedOverDays, adjustmentDays, reason, actorId`,
the row after the change. A system job has no actor: `actorId` is `null` in both the payload and
`audit_log.actor_id`.

Calendar feed events (M4):

| Event | When | Audit `action` |
| --- | --- | --- |
| `calendar_feed.issued` | A person creates a feed link, or gets a new one | `calendar_feed.issued` |
| `calendar_feed.revoked` | A person gets a new link (`reason: "regenerated"`, written before the `issued` for the new one) or turns the feed off (`reason: "turned_off"`) | `calendar_feed.revoked` |

Payload (v1): `feedId, userId, kind, reason, actorId` (`reason` is `null` on `issued`). Neither the payload nor
the audit row (`kind, createdAt, revokedAt`) ever holds the token or its hash.

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
request. The assigned approver or any admin of the company may approve or reject a pending request, with an
optional reason (max 500 characters) stored in `decision_note`. Every status change is a compare-and-set
(`UPDATE ... WHERE status = <expected>`), so of two concurrent decisions exactly one wins and the other gets
`conflict`.

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
must too. Approving never changes remaining (pending and approved both count), and rejecting or cancelling only
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
is overwritten (and audited with actor `null`) by the next run or restart. Balance corrections, including the
M5 allowance editor, go in `adjustment_days`, which the rollover never touches.

Run it with `pnpm job:rollover [year]` (default: the previous year in each company's time zone; needs only
`DATABASE_URL`). The compose `migrate` service runs it after the seed on every start; a failure there is
printed but does not stop the app, since balances work without it and only carryover waits.

Without restarts, schedule it **daily** from a host cron. Running only on Jan 1 is not enough: the carryover
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
  come back to life if the person moved back. When M5 adds moving people between companies, it should revoke
  their live feeds in the same transaction.
- `GET /api/ics/<token>.ics` needs no session (calendar apps cannot sign in). It answers a bare 404 for a
  malformed token (before any query), an unknown or revoked one, and one whose owner is inactive or no longer in
  the feed's company, so deactivating someone stops their feeds at once. Reactivating them revives links they
  never revoked.
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

## Testing

| Command | What | Needs |
| --- | --- | --- |
| `pnpm test` | Unit tests in `tests/unit/` (domain rules, allowance policy, year split, calendar grid, ICS writer, email templates, formatting) | nothing |
| `pnpm test:integration` | Service tests in `tests/integration/` against real Postgres | `TEST_DATABASE_URL` |

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

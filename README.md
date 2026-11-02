# OOOhm

**Out Of Office, Holiday Manager.** Zero resistance time off.

OOOhm is a calm, modern leave tracker for small teams. Employees can request time off in two clicks, managers can approve it, and everyone can see who's out. There's no HR suite attached.

> Status: v1. Deploy it with [docs/deploy.md](docs/deploy.md); move from TimeOff.Management with
> [docs/import.md](docs/import.md).

## What v1 does

- Leave requests (full or half day) with manager approval, and optional self-approval for specific people
- Balances per leave type: a yearly allowance that resets Jan 1, with optional carryover
- A who's-out calendar plus personal and team ICS feeds for Google Calendar
- Per-company working days and public holidays
- Admin screens, an audit log, and an import tool for TimeOff.Management
- Deactivating people, and deleting them for good (a full scrub, or keeping their records), with a CSV export first
- An integration layer (events, REST API, signed webhooks) that other apps can build on

## Stack

Next.js (App Router) · TypeScript · Postgres (or embedded PGlite) · Drizzle ORM · Tailwind · Docker Compose or Vercel

## Run it

```bash
cp .env.example .env   # fill in the values: BETTER_AUTH_SECRET and WEBHOOK_ENCRYPTION_KEY
                       # (each: openssl rand -base64 32), and SEED_ADMIN_EMAIL
docker compose up
```

Then open http://localhost:3000. Outgoing email lands in Mailpit at http://localhost:8025.

`docker compose up` runs five services: `db`, `migrate` (migrations, seed and year rollover, then exits), `app`,
`worker` (the outbox worker, below) and `mailpit`.

Docker is one option, not a requirement. OOOhm runs on any Postgres 15+ (your own, Neon, Supabase, RDS), on Vercel
or a similar platform with no worker process, or with no database server at all (embedded Postgres, for a small
team on one machine: `pnpm build && pnpm start:embedded`). [docs/hosting.md](docs/hosting.md) lists each setup and
exactly what it needs.

### Setting up your company

The first start creates one company, the admin named by `SEED_ADMIN_EMAIL`, and four leave types (PTO,
Emergency, Sick, Bonus). Sign in as that admin (the sign-in link arrives by email), click **Admin** in the
header, and set the rest up there. Nothing needs the database.

1. **Company**: the name, the time zone (it decides what "today" is and when each year starts) and the
   working days. Only working days count as leave.
2. **Departments**: optional groups, used to filter the team view.
3. **Leave types**: add, edit, reorder (the first is the request form's default) or archive. Each has a
   short code for calendars, a colour, a yearly allowance (blank means you set it per person) and optional
   carryover.
4. **Holidays**: add your company's days off, or the US federal holidays for a year in one click. Holidays
   never count as leave; requests already sent keep the days they were counted with.
5. **People**: **Invite someone** with their email, name, role, department and manager. They get an email
   with a sign-in link (valid 15 minutes; after that they can ask for a new one on the sign-in page, or you
   can send one from their page). Nobody can sign up on their own.
6. **Allowances**: on a person's page, **Change allowances** sets their allowance for a year (last year or
   later; older years are closed), or adds or takes away days, with a reason.

Every change is in the **Audit log**, with who made it and when. To retire someone, **Deactivate** them on
their page: they are signed out, their calendar links stop working, their requests stay, and requests waiting
for their approval move to another approver. There is always at least one active admin. The People list hides
deactivated people until you tick **Show inactive**.

To remove someone for good, deactivate them first, then use **Delete…** on their page. You choose how:

- **Remove everything** (the default): nothing about them stays. Their leave, balances and the audit entries about
  them are deleted, and their name and email are taken out of every stored event and webhook. Approvals they made on
  other people's leave stay, under "Former employee #…".
- **Remove their account, keep their records**: their sign-in and email go; their history stays under "<Name>
  (deleted)", and the same email can be invited again as a new account.

The dialog shows exactly what will be removed, offers a CSV of their records first, and asks you to type their name.
Both are permanent. Under **Company** you can make a full removal wait 7 days, with undo. What can't be erased
(webhooks already sent, backups until they expire, a downloaded CSV) is listed in
[architecture.md](docs/architecture.md#people-lifecycle-and-privacy-m8).

### Year rollover

Balances reset on Jan 1. Carryover (off by default, set per leave type) is applied by the year rollover job,
which also creates each person's allowance rows for the new year. It is idempotent, and runs on its own: the
`worker` service runs it once a day (however many workers you run, exactly one does), and `docker compose up`
also runs it after migrations. You can still run it by hand:

```bash
docker compose run --rm migrate pnpm job:rollover        # closes last year
docker compose run --rm migrate pnpm job:rollover 2026   # closes a specific year
```

A host cron is optional. Without the worker, `/api/cron/tick` (or embedded mode's timer) runs it as one of its
daily jobs ([docs/hosting.md](docs/hosting.md)). To run it from cron instead, schedule it daily (not just
on Jan 1), so late changes to last year (an admin's adjustment, a withdrawn request) still update the carryover:

```cron
# The company's time zone; cron otherwise uses the host's.
CRON_TZ=America/Chicago
15 3 * * * cd /srv/ooohm && docker compose run --rm migrate pnpm job:rollover
```

The rollover owns each allowance's carried-over days and recomputes them on every run; correct a balance with
an adjustment instead. See [docs/architecture.md](docs/architecture.md#year-rollover) for the exact rules.

### Calendar subscriptions

Anyone can add their own time off, or everyone's ("who's out"), to a calendar app. In OOOhm, open
**Calendar**, then **Add your time off to Google Calendar, Apple Calendar or Outlook**, and create a link. Copy it
straight away: OOOhm stores only a hash of it, so it is shown once. Anyone with the link can see that calendar;
**Get a new link** or **Turn off** there kills the old one at once.

- **Google Calendar** (web): next to **Other calendars**, click **+**, then **From URL**, paste the link and click
  **Add calendar**. Google fetches it on its own schedule, so changes can take several hours to show, up to about
  a day. It only accepts a public `https` address, so this works once OOOhm is deployed, not against `localhost`.
- **Apple Calendar**: **File**, then **New Calendar Subscription**, paste the link.
- **Outlook**: **Add calendar**, then **Subscribe from web**, paste the link.

Feeds hold approved and pending leave (pending marked "(pending)") from 90 days ago to about 18 months ahead,
and never a request's note. See [docs/architecture.md](docs/architecture.md#calendar-m4) for the format.

Behind a reverse proxy, set `TRUSTED_PROXY_HOPS` in `.env` to the number of proxies that append to
`X-Forwarded-For`, so the feed's rate limit counts each client separately. Leave it at `0` when nothing in front
rewrites that header: a client could otherwise pick its own address.

### Integrations

Other apps can follow and read OOOhm; [docs/api.md](docs/api.md) is the full reference.

- **Webhooks** (**Admin → Integrations → Webhooks**): add an `https://` endpoint and pick events (leave, balances, people, …).
  OOOhm POSTs each event as signed JSON (`OOOhm-Signature`, HMAC-SHA256) and retries a failed delivery 7 times
  over about two days. The endpoint's page shows recent deliveries, sends a test event and resends one.
- **REST API** (**Admin → Integrations → API keys**): create a read-only key, then
  `curl -H "Authorization: Bearer ooohm_..." https://ooohm.example.com/api/v1/users`. The API is described at
  `/api/v1/openapi.json`. Keys are shown once; OOOhm keeps only a hash.
- **Connectors** (**Admin → Integrations → Connectors**): built-in integrations with other systems. None ship in v1.

The **worker** service delivers the webhooks. It reads the events outbox, so nothing is lost while it is down:
deliveries simply wait. It needs only `DATABASE_URL`, `WEBHOOK_ENCRYPTION_KEY` and, optionally, `LOG_LEVEL`,
`WEBHOOK_ALLOW_INSECURE`, `WEBHOOK_ALLOW_PRIVATE`, `WORKER_POLL_INTERVAL_MS` and `WORKER_MAX_IDLE_MS`; it never
gets the auth secret or mail credentials, and runs as an unprivileged user on a read-only filesystem. It does use
the app's database role, so it can still read and write every table; keeping secrets out of its environment is
not database isolation. You can run more than one (`docker compose up --scale worker=2`).
Without a worker (Vercel, embedded mode, or `OOOHM_BACKGROUND=inline`), the app delivers a change's webhooks itself
right after responding, and `GET /api/cron/tick` (or embedded mode's own timer) sends retries; see
[docs/hosting.md](docs/hosting.md).

`GET /api/v1/events` (event replay) shows an event only once every transaction that wrote before it has ended.
Postgres tracks that **server-wide**, across every database on it: a long batch job, or a session left idle in a
transaction after a write, in _any_ database on the same server holds replay back for every OOOhm company until
it ends. Webhooks are not affected. Prefer a dedicated Postgres server, or set
`idle_in_transaction_session_timeout` (e.g. `5min`) on a shared one.

| Variable | |
| --- | --- |
| `WEBHOOK_ENCRYPTION_KEY` | Required by the app and the worker (same value): 32 random bytes in base64, `openssl rand -base64 32`. Encrypts webhook secrets at rest. Changing it makes existing endpoint secrets unreadable; replace each endpoint's secret afterwards. |
| `WEBHOOK_ALLOW_INSECURE`, `WEBHOOK_ALLOW_PRIVATE` | Development only: allow `http://` endpoints, and endpoints on your own machine or network. Keep `false` in production. |
| `LOG_LEVEL` | `debug`, `info` (default), `warn` or `error`. |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_MAX_IDLE_MS` | How often an idle worker looks for work (default 1000 ms, backing off to 10000 ms). |

**Adding an adapter later** (say Gusto) touches no core code: write `src/server/integrations/adapters/gusto.ts`
implementing the `Adapter` interface (`src/server/integrations/adapter.ts`), and list it in
`src/server/integrations/installed.ts`. The worker then delivers the events it `handles` to it with the same
retries as webhooks, and the Connectors screen (**Admin → Integrations → Connectors**) shows its health and,
if it syncs people or allowances, a **Sync now** button. See [docs/architecture.md](docs/architecture.md#integrations-m6).

## Production and moving from TimeOff.Management

`deploy/docker-compose.prod.yml` runs OOOhm behind Caddy with automatic HTTPS; [docs/deploy.md](docs/deploy.md) is
the step-by-step runbook (DNS, firewall, Docker, configuration, email, backups, upgrades, rollback, cutover).
Production settings are listed in `.env.production.example`.

On Vercel with Neon instead: [docs/deploy-vercel.md](docs/deploy-vercel.md) (environment variables, preview-database
safety, the domain, the daily cron, seeding, the import and backups).

`pnpm import:timeoff` brings people, leave types, holidays, allowances and history over from TimeOff.Management's
SQLite file, and refuses to commit unless every current-year balance matches TimeOff's (earlier years are
reported; `--accept-mismatch` overrides). It is a dry run unless you pass `--apply`. See [docs/import.md](docs/import.md).

## Develop

```bash
pnpm typecheck && pnpm lint && pnpm test
TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55502/postgres pnpm test:integration
pnpm test:integration:embedded   # the same suites on embedded PGlite, no server needed
pnpm job:rollover [year]   # year rollover against DATABASE_URL
pnpm worker                # the outbox worker against DATABASE_URL (Ctrl+C stops it gracefully)
pnpm import:timeoff -- --file timeoff.sqlite --company <id> --actor <your email>   # dry run of the TimeOff import (docs/import.md)
```

How the code is organized, and how requests, approvals, balances, the year rollover, calendars and feeds, the admin screens, the audit log, the
events outbox and the integration layer work, is in [docs/architecture.md](docs/architecture.md).

## License

OOOhm is **source-available** under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md) (FSL-1.1-ALv2).

- You can read, run, modify and self-host it, including for your own company's internal use.
- You can't offer it, or something substantially similar built from it, as a competing commercial product or service.
- Two years after each version is released, that version becomes available under the Apache License 2.0.

Copyright 2026 Chykalophia.

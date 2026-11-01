# OOOhm

**Out Of Office, Holiday Manager.** Zero resistance time off.

OOOhm is a calm, modern leave tracker for small teams. Employees can request time off in two clicks, managers can approve it, and everyone can see who's out. There's no HR suite attached.

> Status: early development (v1 in progress). Not ready for production use yet.

## What v1 does

- Leave requests (full or half day) with manager approval, and optional self-approval for specific roles or users
- Balances per leave type: a yearly allowance that resets Jan 1, with optional carryover
- A who's-out calendar plus personal and team ICS feeds for Google Calendar
- Per-company working days and public holidays
- Admin screens, an audit log, and an import tool for TimeOff.Management
- An integration layer (events, REST API, signed webhooks) that other apps can build on

## Stack

Next.js (App Router) · TypeScript · Postgres · Drizzle ORM · Tailwind · Docker Compose

## Run it

```bash
cp .env.example .env   # fill in the values
docker compose up
```

Then open http://localhost:3000. Outgoing email lands in Mailpit at http://localhost:8025.

### Year rollover

Balances reset on Jan 1. Carryover (off by default, set per leave type) is applied by the year rollover job,
which also creates each person's allowance rows for the new year. It is idempotent: `docker compose up` runs
it every time after migrations, and you can run it by hand. Without regular restarts, run it daily from cron
(not just on Jan 1), so late cancellations of last year's leave still update the carryover:

```bash
docker compose run --rm migrate pnpm job:rollover        # closes last year
docker compose run --rm migrate pnpm job:rollover 2026   # closes a specific year
```

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

## Develop

```bash
pnpm typecheck && pnpm lint && pnpm test
TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55502/postgres pnpm test:integration
pnpm job:rollover [year]   # year rollover against DATABASE_URL
```

How the code is organized, and how requests, approvals, balances, the year rollover, calendars and feeds, the audit log and the
events outbox work, is in [docs/architecture.md](docs/architecture.md).

## License

OOOhm is **source-available** under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md) (FSL-1.1-ALv2).

- You can read, run, modify and self-host it, including for your own company's internal use.
- You can't offer it, or something substantially similar built from it, as a competing commercial product or service.
- Two years after each version is released, that version becomes available under the Apache License 2.0.

Copyright 2026 Chykalophia.

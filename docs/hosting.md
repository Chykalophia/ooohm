# Where OOOhm can run

OOOhm is one Next.js app over Postgres. It does not need a particular host: bring your own Postgres, use the Docker
compose files, use Vercel or a similar platform, or, for a small team on one machine, run it with no database server
at all. This page lists the supported setups and exactly what each one needs. How the pieces work inside is in
[architecture.md](architecture.md#hosting-database-and-background-modes).

## The three things every setup decides

**Database.** `DATABASE_URL` is any Postgres 15 or later: the compose `db` service, your own server, Neon, Supabase,
RDS. `sslmode` and the other parameters in the URL are honoured. Behind a *transaction* pooler (Neon's `-pooler`
host, Supabase on port 6543, PgBouncer in transaction mode) prepared statements must be off: OOOhm detects Neon and
Supabase and turns them off; for any other pooler set `DATABASE_POOLER=transaction`. When the URL is pooled, also set
`DATABASE_URL_UNPOOLED` to the direct URL: migrations use it. Or set `OOOHM_DB=embedded` for **embedded** Postgres
(PGlite, in the app's own process, data in `OOOHM_DATA_DIR`, default `./data/pglite`).

**Background work.** Events go out to webhooks (and adapters) with retries, and two jobs run daily (the year
rollover and retention). `OOOHM_BACKGROUND` says who does it:

| Mode | Who | Default where |
| --- | --- | --- |
| `worker` | A long-running `pnpm worker` process beside the app | Docker compose (set there), and anywhere not listed below |
| `inline` | The app, a few milliseconds after each change, after the response (Next's `after()`). Retries and the daily jobs still need a scheduler on `/api/cron/tick`, or embedded mode's own timer | Vercel (`VERCEL` is set), embedded mode |
| `cron` | Only `GET /api/cron/tick`, called by any scheduler with `Authorization: Bearer $CRON_SECRET` | never by default |

The cron route and `inline` work alongside a worker too: every claim is `SKIP LOCKED` or a compare-and-set, so nothing
is sent twice. The route refuses every call until `CRON_SECRET` (32+ characters, `openssl rand -hex 32`) is set.

**Migrations.** `pnpm db:migrate` applies pending migrations; it is safe to run on every start. Embedded mode also
migrates when the app starts.

## Setups

| Setup | Database | Background | Migrations | Backups | Email |
| --- | --- | --- | --- | --- | --- |
| **Docker compose on your server** ([deploy.md](deploy.md)) | The compose `db` service (Postgres 17) | `worker` service | `migrate` service on every `up` | `deploy/backup.sh` nightly (systemd timer), off-site with `OFFSITE_HOOK` | Any SMTP provider on 587 |
| **Node on a VM with systemd** | Any Postgres (local or managed) | Two units: `pnpm start` (or `node .next/standalone/server.js`) and `pnpm worker`, both `Restart=always` | `pnpm db:migrate` before starting the new version | `deploy/backup.sh` with `PG_DUMP='pg_dump -d "$DATABASE_URL"'` from a timer | Any SMTP provider |
| **Vercel + Neon or Supabase** ([deploy-vercel.md](deploy-vercel.md)) | Neon / Supabase pooled URL as `DATABASE_URL`, direct URL as `DATABASE_URL_UNPOOLED` | `inline` (default there) plus Vercel Cron on `/api/cron/tick` (`vercel.json`) | The `vercel-build` script, production deployments only | The provider's restore window, plus `deploy/backup.sh` against the direct URL from any machine | SMTP on 587 (Vercel blocks 25) |
| **Railway, Render or Fly** | The platform's Postgres, or any other | Either a second process (`pnpm worker`, `worker` mode, the default) or `OOOHM_BACKGROUND=inline` plus the platform's scheduler calling `/api/cron/tick` every few minutes | `pnpm db:migrate` as a release / pre-deploy command | The platform's backups, or `deploy/backup.sh` from a scheduled job | Any SMTP provider |
| **Embedded** (no database server) | PGlite in `./data/pglite` (`OOOHM_DATA_DIR`) | In the app: `inline` after each change, and its own timer every `OOOHM_TICK_INTERVAL_SECONDS` (30) for retries and the daily jobs | On every start | Copy the data directory while the app is stopped (a nightly timer that stops it, `tar`s `OOOHM_DATA_DIR`, and starts it again), keeping copies at most 30 days | Any SMTP provider |

Embedded mode, from a checkout: `pnpm install`, `pnpm build`, then `pnpm start:embedded` with `BETTER_AUTH_SECRET`,
`BETTER_AUTH_URL`, `WEBHOOK_ENCRYPTION_KEY`, `SEED_ADMIN_EMAIL` and the `SMTP_*` settings in `.env`. It migrates,
seeds the first admin and starts the app on port 3000 (`PORT`). Put a reverse proxy with HTTPS in front for anything
beyond a trial.

## Limits

- **Embedded is one process.** PGlite is Postgres in single-user mode inside the app, so the app is the only thing
  that may open the data directory: `pnpm worker`, `pnpm db:migrate`, `pnpm db:seed` and the import refuse (naming the
  process that holds it) while the app runs. Stop the app first. Database work is serialized, which is fine for a
  small team and not for a busy one. It does not run on Vercel or any host whose disk does not survive a restart, and
  it is not in the Docker image (`next start` from a checkout serves it). OOOhm has no built-in move from embedded to a
  Postgres server yet: if the team will grow, start on Postgres.
- **Vercel Hobby cron runs once a day**, at a time Vercel picks within the hour. With `inline` mode the webhooks of
  a change still go out within seconds; what waits for the daily cron is a *retry* after a failed delivery, and the
  daily jobs. On Pro, run it every five minutes: set `"schedule": "*/5 * * * *"` in `vercel.json`.
- **Rate limits are kept in memory** per process (the calendar feeds and the REST API). One server counts exactly;
  on Vercel each instance counts on its own, so the limits are approximate there. Submitting leave is limited in
  the database and is exact everywhere.
- **Preview deployments share the production database** unless you stop them: see
  [deploy-vercel.md](deploy-vercel.md#2-keep-previews-away-from-the-production-database).

## Backups bound how long deleted data survives

When a person is deleted (a planned feature), their data stays in every backup taken before, until that backup
is deleted. So the backup retention is the promise: `deploy/backup.sh` keeps local backups at most `RETENTION_DAYS`
(30) days after each nightly run, and the documented off-site hook prunes its copies to the same limit. Any other
copy counts too: a provider's point-in-time restore window (Neon's is part of the plan), Storage Box snapshots,
whole-disk server backups. Keep each of them at 30 days or less, or the promise does not hold there.

# Deploying OOOhm on Vercel with Neon

The runbook for the `ooohm` instance at `https://ooohm.team`: Vercel runs the app, Neon (free plan) holds the
database. Other hosts are in [hosting.md](hosting.md); the Docker runbook is [deploy.md](deploy.md). Work through the
steps in order. Commands run on your own machine, from a checkout of the repository, unless a step says otherwise.

What is already done: the Vercel project `ooohm` exists, its Node.js version is 24.x, preview deployments are turned
off, and the Neon integration is connected. The integration set `DATABASE_URL` (the pooled `-pooler` host) and
`DATABASE_URL_UNPOOLED` (the direct host) for Production and for Preview, and both point at the same database.

## 1. Check the database variables (5 min)

**Project → Settings → Environment Variables** should list `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (Neon also adds
`PG*` and `POSTGRES_*` variables; OOOhm ignores them). Nothing else to do: OOOhm sees the `-pooler` host and turns
prepared statements off for it, keeps its pool small on Vercel (3 connections per instance, closed after 20 idle
seconds), and runs migrations over `DATABASE_URL_UNPOOLED`.

Set **Settings → Functions → Function Region** to the region of the Neon project (Neon's console shows it, e.g.
`aws-us-east-2` → Vercel `iad1` or `cle1`). Every page makes several queries, so a function far from its database
is slow.

## 2. Keep previews away from the production database

The Neon integration gave Preview the **same** database as Production. A preview deployment of a branch would read
and write production data, with that branch's code. Two safeguards:

1. **Preview deployments are off** (the primary safeguard). Confirm it under **Project → Settings → Git** (and
   **Environments**): no preview deployments are built for branches or pull requests. Leave it that way.
2. If you ever turn previews on, first **remove `DATABASE_URL` and `DATABASE_URL_UNPOOLED` from the Preview
   environment** (edit each variable and untick Preview), or give Preview a separate database. Without them a
   preview starts but cannot reach any data.

In code, **only production builds migrate**: the `vercel-build` script runs `scripts/migrate.mts --if-production`,
which does nothing unless `VERCEL_ENV` is `production`. A preview build can therefore never change the shared
schema. There is no read-only "preview mode" at run time: with previews off it would guard nothing, and a guard on
every write path (each action, plus Better Auth's own session writes) is a large surface to keep correct for a
deployment type this project does not use. Keeping preview deployments away from the database is the control.

## 3. Add the environment variables (15 min)

Add each to **Production** only. Use the CLI with `printf '%s'`, which sends the value without a trailing newline.
**Never pipe with `echo`**: it appends a newline, Vercel stores it, and a newline inside a key or password fails far
from its cause (an HTTP library refusing a header, an SMTP login failing). OOOhm trims what it reads, but other
tools reading the same variables do not. `vercel env ls` shows only "Encrypted", so the dashboard cannot reveal one.

```bash
vercel link                                    # once, in the checkout: pick the ooohm project
printf '%s' "$(openssl rand -base64 32)" | vercel env add BETTER_AUTH_SECRET production
printf '%s' "https://ooohm.team"         | vercel env add BETTER_AUTH_URL production
printf '%s' "$(openssl rand -base64 32)" | vercel env add WEBHOOK_ENCRYPTION_KEY production
printf '%s' "$(openssl rand -hex 32)"    | vercel env add CRON_SECRET production
printf '%s' "1"                          | vercel env add TRUSTED_PROXY_HOPS production
```

`TRUSTED_PROXY_HOPS=1`: Vercel's edge sets `X-Forwarded-For` to the client's address, so per-client rate limits
count each client (they are per instance on Vercel, so approximate; see [hosting.md](hosting.md#limits)).
`CRON_SECRET` is what Vercel Cron sends as `Authorization: Bearer <secret>` (step 7). Keep a copy of
`WEBHOOK_ENCRYPTION_KEY` in the password manager: losing it makes every webhook secret unreadable.

Email (step 9 picks the provider), the same way:

```bash
printf '%s' "smtp.postmarkapp.com"            | vercel env add SMTP_HOST production
printf '%s' "587"                             | vercel env add SMTP_PORT production
printf '%s' "false"                           | vercel env add SMTP_SECURE production
printf '%s' "true"                            | vercel env add SMTP_REQUIRE_TLS production
printf '%s' "<smtp user>"                     | vercel env add SMTP_USER production
printf '%s' "<smtp password>"                 | vercel env add SMTP_PASSWORD production
printf '%s' "OOOhm <no-reply@ooohm.team>"     | vercel env add MAIL_FROM production
```

Optional: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (redirect URI `https://ooohm.team/api/auth/callback/google`),
`LOG_LEVEL`. Not needed: `OOOHM_BACKGROUND` (Vercel defaults to `inline`), `DATABASE_POOLER`.

## 4. Connect the GitHub repository (5 min)

**Project → Settings → Git → Connect Git Repository**: the OOOhm repository, production branch `main`. Pushes to `main`
deploy to production. Vercel detects Next.js and runs `pnpm install`, then the `vercel-build` script (migrate, then
`next build`); no build settings need changing.

## 5. The domain (10 min, then DNS)

**Project → Settings → Domains → Add** `ooohm.team`, and `www.ooohm.team` set to redirect to it. Vercel shows the DNS
records to create; add exactly those at the registrar or DNS host that serves `ooohm.team` (typically an `A` record
for the apex and a `CNAME` for `www`; use the values Vercel shows, not ones from memory). If the domain's nameservers
can be moved to Vercel instead, the same screen offers that. Vercel issues the certificate once the records resolve;
the screen turns green.

`BETTER_AUTH_URL` must be exactly `https://ooohm.team`: sign-in links and the server-action origin check use it.

## 6. First deploy and migration (10 min)

Deploy `main` (push, or **Deployments → Redeploy** on the latest commit). The build log shows `Migrations applied.`
before `next build`. A preview build would print `Skipping migrations: VERCEL_ENV is "preview"`. If the build stops
with a database error, the deployment is not promoted and the previous one keeps serving.

Check `https://ooohm.team/api/health` answers `{"status":"ok"}`.

Every deployment runs the migrations again before building; they are idempotent. A migration that breaks the new
code is fixed forward (Vercel's instant rollback restores the old code, not the old schema): see
[deploy.md](deploy.md#15-rollback-10-min) for the trade-off.

## 7. Background work: inline plus the daily cron (5 min)

On Vercel the app delivers webhooks itself, right after each change (`inline`). `vercel.json` adds a cron calling
`GET /api/cron/tick` once a day (07:00 UTC) for what needs a clock: retries of failed deliveries and the daily jobs
(year rollover, retention). Hobby allows one run a day; on Pro, change `"schedule"` in `vercel.json` to
`"*/5 * * * *"` so retries go out within minutes. Check it under **Settings → Cron Jobs**; **Run** sends one now, and
its log line is `cron_tick` with counts.

## 8. Seed the first admin (10 min)

Run the seed from your machine against the direct URL. Pull the production variables into a scratch file **outside
the repository**, and delete it afterwards:

```bash
vercel env pull --environment=production ~/ooohm-prod.env
grep -n '\\n"' ~/ooohm-prod.env   # must print nothing; see below
set -a; . ~/ooohm-prod.env; set +a
DATABASE_URL="$DATABASE_URL_UNPOOLED" SEED_ADMIN_EMAIL=peter@chykalophia.com SEED_COMPANY_NAME=Chykalophia pnpm db:seed
```

`vercel env pull` writes a stored newline as the two characters `\n` inside the quotes; the `grep` finds any such
value, which means the variable was stored dirty: re-add it with `printf '%s'` (step 3) and redeploy. Keep the file
for step 10, then `rm ~/ooohm-prod.env`.

Open `https://ooohm.team`, enter that address, click the link in the email. The seed is idempotent: running it
again never changes the admin.

## 9. Email: SMTP on 587, SPF, DKIM, DMARC (30 min, then DNS)

Vercel blocks outbound port 25, so use a provider's submission port 587 with STARTTLS (`SMTP_SECURE=false`,
`SMTP_REQUIRE_TLS=true`, as in step 3). Port 465 (`SMTP_SECURE=true`) also works. The sending domain needs SPF, DKIM
and DMARC records from the provider: the table and the test are in [deploy.md](deploy.md#10-email-provider-spf-dkim-dmarc-30-min-then-dns-propagation).
After changing an `SMTP_*` variable, redeploy: Vercel reads variables when a deployment is built.

## 10. Import from TimeOff.Management (30 min)

Read [import.md](import.md) and [deploy.md step 11](deploy.md#11-import-from-timeoffmanagement-30-min) first; only
the commands differ. With `~/ooohm-prod.env` loaded (step 8) and the exported `timeoff.sqlite` on your machine:

```bash
psql "$DATABASE_URL_UNPOOLED" -c "select id, name from companies"      # the seeded company's id
DATABASE_URL="$DATABASE_URL_UNPOOLED" pnpm import:timeoff -- --file ~/timeoff.sqlite --company <id> \
  --actor peter@chykalophia.com --report ~/ooohm-dry-run.json
# Read the report: every current-year row must say Diff 0. Then the same with --apply.
```

Back up first (step 11). The import runs as one transaction over the direct connection. Delete `timeoff.sqlite`, the
reports and `~/ooohm-prod.env` from your machine after cutover.

## 11. Backups (20 min)

Two layers:

1. **Neon's restore window.** Neon keeps the database's history for a few hours on the free plan (the project's
   **Settings → Instant restore / History retention** shows the current window) and can restore or branch from any
   moment in it. It covers a bad migration or import noticed quickly; it is not a backup.
2. **Nightly dumps with `deploy/backup.sh`**, from any machine that is on every night (a home server, a small VM),
   against the direct URL. It needs `pg_dump` 17 or later (Neon runs Postgres 17), `gzip` and a checkout of the
   repository:

   ```bash
   #!/usr/bin/env bash
   # /usr/local/bin/ooohm-neon-backup (chmod 700), run nightly by cron or a systemd timer
   set -euo pipefail
   export DATABASE_URL_UNPOOLED="$(cat /root/ooohm-neon-url)"   # chmod 600; the direct URL, no newline
   export PG_DUMP='pg_dump -d "$DATABASE_URL_UNPOOLED"'
   export BACKUP_DIR=/var/backups/ooohm RETENTION_DAYS=30
   exec /srv/ooohm/deploy/backup.sh
   ```

   Off-site copies, encryption and the pruning hook work exactly as in [deploy.md](deploy.md#13-backups-20-min).

Backups bound how long a deleted person's data survives: keep every copy (dumps, off-site copies, Neon's restore
window) at 30 days or less. See [hosting.md](hosting.md#backups-bound-how-long-deleted-data-survives).

To restore: create a Neon branch or a new database, `pg_restore` the dump into it with `deploy/restore.sh`'s steps
(or `gzip -dc <file> | pg_restore -d "<new direct URL>" --no-owner`), check it, then point `DATABASE_URL` and
`DATABASE_URL_UNPOOLED` at it and redeploy.

## 12. Cutover checklist

The same bar as [deploy.md](deploy.md#17-cutover-checklist):

- [ ] `https://ooohm.team` serves over HTTPS with a valid certificate; `/api/health` answers `{"status":"ok"}`.
- [ ] Preview deployments are off, or Preview has no database variables (step 2).
- [ ] Sign-in email arrives within a minute and passes SPF, DKIM and DMARC.
- [ ] **Settings → Cron Jobs** lists `/api/cron/tick`, and a manual run logs `cron_tick`.
- [ ] Backups run nightly, are copied off the machine, and one restore drill has been done (step 11).
- [ ] **Every person's balance matches TimeOff**: the applied import reported `Diff 0` for every current-year row,
      and three people were spot-checked by hand against TimeOff's screens.
- [ ] **Everyone has requested time off once and had it approved** in OOOhm. Keep a list; it proves each person can
      sign in and each approval route works.
- [ ] The team calendar feed shows in Google Calendar.
- [ ] **TimeOff.Management is shut down**: its service stopped, its DNS record removed or pointed at OOOhm, and its
      final SQLite file archived (encrypted) with the import report. `~/ooohm-prod.env` and the SQLite copy are
      deleted from your machine.
- [ ] The ClickUp task for M7 is set to its terminal status, and `LIVE: ooohm.team` is posted in the client channel.

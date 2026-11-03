# Deploying OOOhm on Vercel with Neon

A runbook for running your own OOOhm on Vercel, with Neon (free plan) holding the database. It uses `hr.example.com` for
the address people will use and `hrtemp.example.com` for a temporary one while an old system still holds the final
address (step 5); put your own in their place. Vercel runs the app, Neon holds the
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
printf '%s' "https://hrtemp.example.com"   | vercel env add BETTER_AUTH_URL production   # hr.example.com at cutover (step 5)
printf '%s' "$(openssl rand -base64 32)" | vercel env add WEBHOOK_ENCRYPTION_KEY production
printf '%s' "$(openssl rand -hex 32)"    | vercel env add CRON_SECRET production
printf '%s' "1"                          | vercel env add TRUSTED_PROXY_HOPS production
```

`TRUSTED_PROXY_HOPS=1`: Vercel's edge sets `X-Forwarded-For` to the client's address, so per-client rate limits
count each client (they are per instance on Vercel, so approximate; see [hosting.md](hosting.md#limits)).
`CRON_SECRET` is what Vercel Cron sends as `Authorization: Bearer <secret>` (step 7). Keep a copy of
`WEBHOOK_ENCRYPTION_KEY` in the password manager: losing it makes every webhook secret unreadable.

Email through SendGrid's API (step 9), the same way:

```bash
printf '%s' "sendgrid"                        | vercel env add MAIL_TRANSPORT production
printf '%s' "<API key, Mail Send only>"       | vercel env add SENDGRID_API_KEY production
printf '%s' "OOOhm <no-reply@example.com>"    | vercel env add MAIL_FROM production   # a domain you control
```

Another provider over SMTP instead: `MAIL_TRANSPORT=smtp` (the default) with `SMTP_HOST`, `SMTP_PORT=587`,
`SMTP_SECURE=false`, `SMTP_REQUIRE_TLS=true`, `SMTP_USER` and `SMTP_PASSWORD`.

Optional: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (redirect URIs `https://hrtemp.example.com/api/auth/callback/google` and
`https://hr.example.com/api/auth/callback/google`),
`LOG_LEVEL`. Not needed: `OOOHM_BACKGROUND` (Vercel defaults to `inline`), `DATABASE_POOLER`.

## 4. Connect the GitHub repository (5 min)

**Project → Settings → Git → Connect Git Repository**: the OOOhm repository, production branch `main`. Pushes to `main`
deploy to production. Vercel detects Next.js and runs `pnpm install`, then the `vercel-build` script (migrate, seed
when `SEED_ADMIN_EMAIL` is set, then `next build`); no build settings need changing.

**Only `main` deploys.** `vercel.json` turns off Git deployments for every other branch (`git.deploymentEnabled`), and
the project's **Settings → Git → Ignored Build Step** is `[ "$VERCEL_GIT_COMMIT_REF" = "main" ] && exit 1 || exit 0` as
a second guard (it applies to branches whose own `vercel.json` predates the first). Check **Settings → Environments →
Production → Branch Tracking** says `main`: a push to the branch named there goes straight to production, on the
production database.

## 5. The domain, and moving off a temporary one (10 min, then DNS)

If the old system (TimeOff.Management, say) still serves the address people will use, start OOOhm on a temporary one and
move it on the day the old system goes. With the final address free already, skip the temporary one: add the final
domain now and set `BETTER_AUTH_URL` to it.

**Now:** **Project → Settings → Domains → Add** `hrtemp.example.com`, and create the record Vercel shows (a `CNAME` for a
subdomain; use its value, not one from memory) at your DNS host. Vercel issues the certificate once it
resolves. `BETTER_AUTH_URL` is `https://hrtemp.example.com` (step 3).

**At cutover** (step 12, once the import is applied and checked):

1. An hour before, lower the TTL of the final address's DNS record, so the switch spreads quickly.
2. Stop TimeOff.Management, then **Domains → Add** `hr.example.com` and point its record at Vercel as shown.
3. When its certificate is issued, change the address and redeploy:

   ```bash
   vercel env rm BETTER_AUTH_URL production
   printf '%s' "https://hr.example.com" | vercel env add BETTER_AUTH_URL production
   ```

4. Edit `hrtemp.example.com` under **Domains** to **Redirect to** `hr.example.com` (308), and keep it a while.

What the switch changes: everyone signs in once more (a session belongs to its host). Sign-in and Approve links already
emailed keep working through the redirect. Calendar feed links carry the host, so hand them out only after the
switch; anyone who subscribed on `hrtemp` copies the link again from **Calendar → Subscribe**.

`BETTER_AUTH_URL` must be exactly the address people use, without a trailing slash: sign-in links, email links and the
server-action origin check use it.

## 6. First deploy and migration (10 min)

Deploy `main` (push, or **Deployments → Redeploy** on the latest commit). The build log shows `Migrations applied.`
before `next build`. A preview build would print `Skipping migrations: VERCEL_ENV is "preview"`. If the build stops
with a database error, the deployment is not promoted and the previous one keeps serving.

Check `https://hrtemp.example.com/api/health` answers `{"status":"ok"}`.

Every deployment runs the migrations again before building; they are idempotent. A migration that breaks the new
code is fixed forward (Vercel's instant rollback restores the old code, not the old schema): see
[deploy.md](deploy.md#15-rollback-10-min) for the trade-off.

## 7. Background work: inline plus the daily cron (5 min)

On Vercel the app delivers webhooks itself, right after each change (`inline`). `vercel.json` adds a cron calling
`GET /api/cron/tick` once a day (07:00 UTC) for what needs a clock: retries of failed deliveries and the daily jobs
(year rollover, retention). Hobby allows one run a day; on Pro, change `"schedule"` in `vercel.json` to
`"*/5 * * * *"` so retries go out within minutes. Check it under **Settings → Cron Jobs**; **Run** sends one now, and
its log line is `cron_tick` with counts.

## 8. Set up the company and the first admin (5 min)

In the browser, once email works (step 9: the first admin signs in with an emailed link).

1. Make a setup token, add it, and redeploy so the deployment reads it:

   ```bash
   SETUP_TOKEN="$(openssl rand -hex 32)"; echo "$SETUP_TOKEN"   # keep it until step 3
   printf '%s' "$SETUP_TOKEN" | vercel env add SETUP_TOKEN production
   ```

2. Open `https://hrtemp.example.com/setup`, give the token, the company name, its time zone, your name and
   your work email. It creates the company, the default leave types (PTO first) and you as its admin, audited
   as `first_install`, then sends you to sign in with your email filled in.
3. **Remove the token**: `vercel env rm SETUP_TOKEN production`. Setup is already closed for good (an install marker,
   plus any company or person, keeps `/setup` a 404 whatever the token says), so this only removes a secret nobody
   needs any more.

`/setup` is a 404 while `SETUP_TOKEN` is unset and after setup, and a wrong token changes nothing.

**Prefer a command?** `scripts/seed.mts` creates the same company and admin, and closes `/setup` too. Either:

- **Let the deploy run it:** add `SEED_ADMIN_EMAIL` (and optionally `SEED_COMPANY_NAME`, `SEED_ADMIN_NAME`) to
  Production and redeploy. `vercel-build` runs `scripts/seed.mts --if-production` after migrating; it seeds only on a
  production build with `SEED_ADMIN_EMAIL` set and while no company exists, so later builds skip it. (`SEED_ON_DEPLOY=force`
  for one deploy seeds an existing instance anyway; it only fills gaps.)
- **Or run it yourself:** with the production variables loaded (below),
  `DATABASE_URL="$DATABASE_URL_UNPOOLED" SEED_ADMIN_EMAIL=<your email> SEED_COMPANY_NAME=<company> pnpm db:seed`.

For step 10 you need the production variables locally anyway:

```bash
vercel env pull --environment=production ~/ooohm-prod.env
grep -n '\\n"' ~/ooohm-prod.env   # must print nothing; see below
set -a; . ~/ooohm-prod.env; set +a
```

`vercel env pull` writes a stored newline as the two characters `\n` inside the quotes; the `grep` finds any such
value, which means the variable was stored dirty: re-add it with `printf '%s'` (step 3) and redeploy. Delete
`~/ooohm-prod.env` after step 10.

## 9. Email: SendGrid, with SPF, DKIM and DMARC (30 min, then DNS)

OOOhm sends through SendGrid's HTTPS API (`MAIL_TRANSPORT=sendgrid`, step 3): port 443, so Vercel's block on port 25
never matters, and SendGrid's own error comes back in the log (`magic_link_send_failed`, `email_send_failed`).

1. **Sender Authentication → Authenticate Your Domain**: the domain of `MAIL_FROM` (the address mail comes
   from; set `MAIL_FROM` to one on a domain you control), with its DNS host. Add the CNAME records
   SendGrid shows (DKIM and the return path), and a DMARC record if the domain has none
   (`_dmarc.<your domain> TXT "v=DMARC1; p=quarantine; rua=mailto:<you>"`). Wait for **Verify** to pass.
2. **Settings → API Keys → Create**: restricted access, **Mail Send** only. That is `SENDGRID_API_KEY`; SendGrid shows
   it once.
3. **Settings → Tracking**: turn off click tracking and open tracking. OOOhm already turns both off on every message
   it sends (rewritten links would break sign-in and Approve links, whose tokens are in the URL); this keeps any
   other mail from the account consistent.
4. An account with EU data residency also needs `SENDGRID_REGION=eu`.

After changing a mail variable, redeploy: Vercel reads variables when a deployment is built. The test: send yourself a
sign-in link and check the message headers show `dkim=pass`, `spf=pass` and `dmarc=pass`.

Any other provider: over SMTP, on submission port 587 with STARTTLS (step 3); or as its own transport in
`src/lib/mail` (one file implementing `MailTransport`, one line in its registry).

## 10. Import from TimeOff.Management (30 min)

Read [import.md](import.md) and [deploy.md step 11](deploy.md#11-import-from-timeoffmanagement-30-min) first; only
the commands differ. With `~/ooohm-prod.env` loaded (end of step 8) and the exported `timeoff.sqlite` on your machine:

```bash
psql "$DATABASE_URL_UNPOOLED" -c "select id, name from companies"      # the company setup created
DATABASE_URL="$DATABASE_URL_UNPOOLED" pnpm import:timeoff -- --file ~/timeoff.sqlite --company <id> \
  --actor <your email> --report ~/ooohm-dry-run.json
# Read the report: every current-year row must say Diff 0. Then the same with --apply.
```

Back up first (step 11). The import runs as one transaction over the direct connection. Delete `timeoff.sqlite`, the
reports and `~/ooohm-prod.env` from your machine after cutover.

Then, in the app, **Admin → Leave types: drag PTO to the top.** The import keeps TimeOff's order, and the first
active type is the request form's default and the one Home's year-end note names ("6 days of PTO won't carry into
2027"). Nobody should be nudged to use up emergency or sick days.

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

- [ ] `https://hr.example.com` serves over HTTPS with a valid certificate; `/api/health` answers `{"status":"ok"}`;
      `BETTER_AUTH_URL` is `https://hr.example.com`, and `hrtemp.example.com` redirects to it (step 5).
- [ ] Preview deployments are off, or Preview has no database variables (step 2).
- [ ] `/setup` answers "could not be found", and `SETUP_TOKEN` is removed from the project (step 8).
- [ ] Sign-in email arrives within a minute and passes SPF, DKIM and DMARC.
- [ ] **Settings → Cron Jobs** lists `/api/cron/tick`, and a manual run logs `cron_tick`.
- [ ] Backups run nightly, are copied off the machine, and one restore drill has been done (step 11).
- [ ] **Every person's balance matches TimeOff**: the applied import reported `Diff 0` for every current-year row,
      and three people were spot-checked by hand against TimeOff's screens.
- [ ] PTO is the first leave type under **Admin → Leave types** (step 10).
- [ ] **Everyone has requested time off once and had it approved** in OOOhm. Keep a list; it proves each person can
      sign in and each approval route works.
- [ ] The team calendar feed shows in Google Calendar.
- [ ] **TimeOff.Management is shut down**: its service stopped, its DNS record removed or pointed at OOOhm, and its
      final SQLite file archived (encrypted) with the import report. `~/ooohm-prod.env` and the SQLite copy are
      deleted from your machine.
- [ ] The team knows the new address, and the old system's bookmarks point at it.

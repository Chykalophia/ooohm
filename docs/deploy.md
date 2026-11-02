# Deploying OOOhm

A runbook for one OOOhm deployment on a fresh Hetzner Cloud server running Ubuntu 24.04, served at
`ooohm.team`. It uses `deploy/docker-compose.prod.yml`: Postgres, the migrations job, the app, the outbox worker
and Caddy, which terminates HTTPS and is the only thing reachable from the internet. It is one of several ways to
run OOOhm: [hosting.md](hosting.md) compares them, and [deploy-vercel.md](deploy-vercel.md) is the runbook for Vercel
with Neon.

OOOhm is source-available under FSL-1.1-ALv2 (see [LICENSE.md](../LICENSE.md)).

Commands below run on the server as a sudo-capable user unless they say otherwise. Times are rough.

## 1. What you need (15 min)

- A Hetzner Cloud server: Ubuntu 24.04, 2 vCPU and 4 GB RAM is plenty for a small team (building the image is the
  heaviest step). Add your SSH key when creating it, and attach a Hetzner Cloud Firewall (step 3).
- The domain `ooohm.team` with access to its DNS records.
- An account with a transactional email provider (Postmark, Amazon SES, Mailgun or similar) that can send from
  `ooohm.team`.
- Read access to the private GitHub repository for a deploy key (step 5).

## 2. DNS (5 min, then wait)

At the DNS provider, point the domain at the server:

| Type | Name | Value |
| --- | --- | --- |
| `A` | `ooohm.team` (or `@`) | the server's IPv4 address |
| `AAAA` | `ooohm.team` (or `@`) | the server's IPv6 address (Hetzner gives a /64; use `<prefix>::1`) |

Check from your machine before step 7: `dig +short ooohm.team A` and `dig +short ooohm.team AAAA`. Caddy asks
Let's Encrypt for a certificate on first start, which needs these records to resolve to this server and ports 80
and 443 to be open.

## 3. Server basics and firewall (15 min)

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install unattended-upgrades ufw git
sudo dpkg-reconfigure -plow unattended-upgrades

sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp      # HTTP/3
sudo ufw enable
```

Docker publishes container ports through its own iptables rules, which bypass ufw. Only Caddy publishes ports
(80 and 443) in this stack, so that is what is exposed either way; Postgres, the app and the worker publish
nothing. For a second layer that Docker cannot bypass, add the same three rules (22, 80, 443 TCP and 443 UDP) in a
**Hetzner Cloud Firewall** attached to the server.

Also: log in with SSH keys only (`PasswordAuthentication no` in `/etc/ssh/sshd_config`), and keep the server's
clock on NTP (Ubuntu's default `systemd-timesyncd` does).

## 4. Install Docker (10 min)

Docker's own apt repository (Ubuntu's `docker.io` package lags behind and has no Compose plugin):

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"    # then log out and back in
docker compose version
```

## 5. Get the code (10 min)

The repository is private, so use a read-only **deploy key** for this server:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ooohm_deploy -N "" -C "ooohm deploy key"
cat ~/.ssh/ooohm_deploy.pub
```

In GitHub: the repository's **Settings → Deploy keys → Add deploy key**, paste the public key, leave **Allow write
access** off. Then:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-ooohm
  HostName github.com
  User git
  IdentityFile ~/.ssh/ooohm_deploy
  IdentitiesOnly yes
EOF
sudo mkdir -p /srv/ooohm && sudo chown "$USER" /srv/ooohm
git clone github-ooohm:Chykalophia/ooohm.git /srv/ooohm
cd /srv/ooohm
git checkout <release tag or commit>    # deploy a known version, not whatever main is today
```

## 6. Configure (10 min)

```bash
cd /srv/ooohm
cp .env.production.example .env.production
chmod 600 .env.production
openssl rand -base64 32    # BETTER_AUTH_SECRET
openssl rand -hex 24       # POSTGRES_PASSWORD
openssl rand -base64 32    # WEBHOOK_ENCRYPTION_KEY
nano .env.production
```

Set every value marked REQUIRED: `OOOHM_DOMAIN=ooohm.team`, `ACME_EMAIL`, `BETTER_AUTH_URL=https://ooohm.team`,
`BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`, `SEED_ADMIN_EMAIL` (your own address: the first admin), the `SMTP_*`
settings and `MAIL_FROM` (step 10). `DATABASE_URL` is built by the compose file from `POSTGRES_PASSWORD`.

Keep a copy of `.env.production` in your password manager. Losing `WEBHOOK_ENCRYPTION_KEY` makes webhook secrets
unreadable; losing `BETTER_AUTH_SECRET` signs everyone out (nothing else).

`POSTGRES_PASSWORD` is set into the database the first time it starts. Changing it in the file later does not
change it in Postgres; to rotate it, run
`ALTER USER ooohm PASSWORD '<new>'` (step 16 shows how to reach `psql`), then update the file and run step 7 again.

To save typing, define a helper in your shell profile (`~/.bashrc`):

```bash
ooohm() { docker compose --env-file /srv/ooohm/.env.production -f /srv/ooohm/deploy/docker-compose.prod.yml "$@"; }
```

The rest of this runbook uses `ooohm <compose command>`.

## 7. Start (10 min, mostly the build)

```bash
cd /srv/ooohm
ooohm config --quiet && echo "config OK"   # names any missing variable
ooohm up -d --build
ooohm ps
```

Order: Postgres becomes healthy, `migrate` runs the migrations, the first-run seed and the year rollover, then
exits; the app and the worker start; Caddy starts once the app's healthcheck passes and fetches the certificate.
Check from your machine:

```bash
curl -sS https://ooohm.team/api/health          # {"status":"ok"}
curl -sSI https://ooohm.team/sign-in | grep -iE 'strict-transport|x-frame|x-content-type|content-security'
```

If the certificate fails, `ooohm logs caddy` says why (usually DNS not pointing here yet, or port 80 closed).
Caddy retries on its own.

## 8. First sign-in (5 min)

The seed created the company (`SEED_COMPANY_NAME`), its first admin (`SEED_ADMIN_EMAIL`), and four default leave
types. Open `https://ooohm.team`, enter that address, and click the link in the email.

If you are importing from TimeOff (step 11), leave the company settings alone: the import sets the time zone and
working days from TimeOff (and audits the change), overwriting anything set here. It also expects a freshly seeded
company, so do **not** invite people or add leave types yet either. Check the settings under **Admin** after
step 11. If you are not importing, set the company's time zone and working days under **Admin** now.

Running the stack again (`ooohm up -d`) never re-creates or changes the admin: the seed only fills gaps.

## 9. What runs where

| Service | Role | Exposed |
| --- | --- | --- |
| `caddy` | HTTPS (Let's Encrypt), HTTP→HTTPS redirect, security headers, zstd/gzip, 2 MB request body limit, access log | 80, 443 (TCP and UDP) |
| `app` | The Next.js server, as an unprivileged user with no Linux capabilities | only to Caddy |
| `worker` | Webhooks, the daily year rollover and retention; read-only filesystem, its own minimal environment | nothing |
| `migrate` | Migrations, seed, rollover on every `up`; then exits | nothing |
| `db` | Postgres 17, data in the `pgdata` volume | nothing (backend network only; Caddy cannot reach it) |

Details that matter:

- **Client addresses.** Caddy replaces any `X-Forwarded-For` a client sends with the real address, and the compose
  file sets `TRUSTED_PROXY_HOPS=1`, so per-client rate limits (calendar feeds, the API) count each client. Do not
  put another proxy or CDN in front without raising it to match (see
  [architecture.md](architecture.md#feed-tokens)).
- **Server actions.** Next.js checks that a form post's `Origin` matches the host. Caddy forwards the public host
  unchanged, so no `serverActions.allowedOrigins` is configured. A proxy that rewrites the host would need it.
- **Headers.** Caddy adds `Strict-Transport-Security` (one year), `X-Content-Type-Options`, `X-Frame-Options:
  DENY`, `Referrer-Policy` (unless the app set one: calendar feeds use `no-referrer`), `Permissions-Policy` and a
  `Content-Security-Policy` limited to framing, `<base>` and plugins, and removes `Server` and `Via`. Next.js sets
  none of these; its `X-Powered-By` is off. A CSP that also restricts scripts needs per-request nonces from
  Next.js; that is future work.
- **Tokens never reach the logs.** Calendar feed tokens are in URL paths (`/api/ics/<token>.ics`) and sign-in
  tokens in query strings. Every Caddy logger (the access log, and through the global `log default` the error log
  written while the app is down or restarting) keeps the path without any query string, cuts the feed token off,
  and drops the `Referer` header and the `Location` of redirects (the HTTP-to-HTTPS redirect repeats the full
  URL); Caddy never logs cookies or `Authorization`. This was checked with the app stopped (502s) and with plain
  HTTP requests (308s): `docker logs` held no token. The app logs structured events with ids, never URLs, tokens
  or email addresses of sign-in requests.
- **Logs rotate**: Docker keeps 5 files of 10 MB per container.

## 10. Email: provider, SPF, DKIM, DMARC (30 min, then DNS propagation)

Sign-in links are email, so mail must be delivered reliably. Use a transactional provider rather than sending
from the server: Hetzner blocks outgoing ports 25 and 465 on new accounts, and a fresh IP has no reputation.

1. At the provider, add the sending domain `ooohm.team` (or a subdomain such as `mail.ooohm.team`) and verify it.
2. Add the DNS records the provider gives you. Typically:

   | Type | Name | Value (example; use your provider's) |
   | --- | --- | --- |
   | `TXT` | `ooohm.team` | `v=spf1 include:spf.mtasv.net ~all` (Postmark; SES: `include:amazonses.com`; Mailgun: `include:mailgun.org`). One SPF record per name: merge includes if one exists. |
   | `TXT` or `CNAME` | `<selector>._domainkey.ooohm.team` | the DKIM key or CNAME from the provider |
   | `TXT` | `_dmarc.ooohm.team` | `v=DMARC1; p=none; rua=mailto:dmarc@ooohm.team` to start; move to `p=quarantine` once reports look clean |
   | `CNAME` | return-path host (e.g. `pm-bounces.ooohm.team`) | the provider's bounce domain, if it offers one (aligns SPF for DMARC) |

3. Put the SMTP settings in `.env.production` (`.env.production.example` lists them for Postmark, SES and
   Mailgun): `SMTP_HOST`, `SMTP_PORT=587`, `SMTP_SECURE=false` (STARTTLS), `SMTP_REQUIRE_TLS=true` (the default: the app refuses to send if
   STARTTLS fails, rather than sending the password and sign-in links in clear text), `SMTP_USER`, `SMTP_PASSWORD`, and
   `MAIL_FROM=OOOhm <no-reply@ooohm.team>` with a verified sender. Then `ooohm up -d` (recreates the app with the
   new settings).
4. Test: sign out, request a sign-in link for your own address, and check the received message's headers for
   `spf=pass`, `dkim=pass` and `dmarc=pass` (Gmail: **Show original**). If nothing arrives, `ooohm logs app | grep
   email` shows the failure (codes only, never the address).

Never point `SMTP_*` at a real provider while testing with made-up addresses; use the development compose and
Mailpit for that.

## 11. Import from TimeOff.Management (30 min)

Read [import.md](import.md) first: it explains the mapping and what the reconciliation compares.

1. **Freeze TimeOff**: tell everyone not to change anything there from now until cutover, and export the database
   (on the TimeOff host): `sqlite3 db.development.sqlite ".backup '/tmp/timeoff.sqlite'"`.
2. **Copy it up** (from your machine): `scp timeoff.sqlite <server>:/srv/ooohm-import/timeoff.sqlite`, then on the
   server `chmod 600 /srv/ooohm-import/timeoff.sqlite`. It holds everyone's data; delete it after cutover.
3. **Back up** first: `/srv/ooohm/deploy/backup.sh` (step 13).
4. **Find the company id** the seed created:
   `ooohm exec db psql -U ooohm -d ooohm -c "select id, name from companies"`.
5. **Dry run** (writes nothing). `--actor` is you, the admin running it (the seeded `SEED_ADMIN_EMAIL`, or any
   active admin of the company): every imported row is recorded in the audit log as your change, via the import.

   ```bash
   ooohm run --rm -v /srv/ooohm-import:/import migrate \
     pnpm import:timeoff -- --file /import/timeoff.sqlite --company <id> --actor <your email> --report /import/dry-run.json
   ```

   If several TimeOff leave types use the allowance, it stops and explains `--merge-pool-types` and `--pool-type`;
   add them and run again.
6. **Read the report.** The reconciliation table must show `Diff 0` for every row of the current year. Read the
   conflicts (duplicate or unusable emails) and warnings (pended revokes, part-time schedules, supervisors). Fix
   anything that should be fixed in TimeOff, export again, and repeat from step 2.
7. **Apply**: the same command with `--apply`. It commits only if the current year reconciles; otherwise it rolls
   back and says why. It records the import, so the company cannot be imported into again, from this file or a
   newer export, even with `--force` (that would add every leave a second time). To redo an applied import,
   restore the backup from step 3 ([Restore](#restore)) and import the new export once.
8. **Spot-check**: sign in as yourself, open **Admin → People**, pick three people, and compare each one's
   balance with TimeOff's screen for them. **Admin → Audit log** shows the import under "Imported: ...", made by
   you, "via time-off import".

Imported people get no email. Tell them to open `https://ooohm.team` and sign in with their work address.

## 12. Calendar feeds in Google Calendar (10 min)

1. In OOOhm, **Calendar → Add your time off to Google Calendar, Apple Calendar or Outlook**, create the team link
   and copy it (it is shown once).
2. In Google Calendar on the web: **Other calendars → + → From URL**, paste it, **Add calendar**.
3. Google fetches it on its own schedule: the first events can take from minutes to several hours to appear.
   `curl -s "<link>" | head` from anywhere shows the feed straight away (`BEGIN:VCALENDAR`).

## 13. Backups (20 min)

`deploy/backup.sh` dumps the database (`pg_dump` custom format, gzipped), names it by UTC time, checks it, and
deletes old ones: after each nightly run, no backup on the server is older than `RETENTION_DAYS` (30 days). That
limit is what bounds how long a deleted person's data survives in backups, so keep the off-site copies (below) to
the same limit. Install the nightly timer:

```bash
sudo mkdir -p /var/backups/ooohm && sudo chmod 700 /var/backups/ooohm
sudo cp /srv/ooohm/deploy/systemd/ooohm-backup.service /srv/ooohm/deploy/systemd/ooohm-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ooohm-backup.timer
sudo systemctl start ooohm-backup.service && ls -l /var/backups/ooohm    # one backup now
systemctl list-timers ooohm-backup.timer
```

The service runs as root (it needs Docker). Without systemd, cron works the same:
`30 2 * * * /srv/ooohm/deploy/backup.sh >> /var/log/ooohm-backup.log 2>&1`.

**Off-site copies.** A backup on the same disk does not survive losing the server. Set `OFFSITE_HOOK` to a command
that receives the new file's path.

A backup holds personal data (every person's name, email, leave history and notes), the audit log, and session
and sign-in rows. **Never copy it off the server unencrypted.** Encrypt it with [age](https://age-encryption.org)
to a public key whose private key is **not** on the server (keep it in the password manager), then upload the
encrypted file. Once, on your own machine: `age-keygen -o ooohm-backup.key` (it prints the public key,
`age1...`). On the server, `sudo apt install -y age rclone`, set up an `rclone` remote named `storagebox` for a
Hetzner Storage Box (`sudo rclone config`; it is stored in the root-owned `/root/.config/rclone/rclone.conf`), and:

```bash
sudo tee /usr/local/bin/ooohm-offsite >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# The public key only: the server can encrypt backups but never read the copies back.
recipient="age1...your public key..."
encrypted="$(mktemp)"
trap 'rm -f "$encrypted"' EXIT
age -r "$recipient" -o "$encrypted" "$1"
rclone copyto --config /root/.config/rclone/rclone.conf "$encrypted" "storagebox:ooohm/$(basename "$1").age"
# Same limit as the local copies: backup.sh exports RETENTION_DAYS. An hour short of it, like
# backup.sh, so the nightly run on the day a copy turns RETENTION_DAYS old removes it.
rclone delete --config /root/.config/rclone/rclone.conf --min-age "$(( ${RETENTION_DAYS:-30} * 24 - 1 ))h" "storagebox:ooohm/"
EOF
sudo chmod 700 /usr/local/bin/ooohm-offsite
```

To restore from an off-site copy, download the `.age` file and decrypt it where the private key is
(`age -d -i ooohm-backup.key -o <file> <file>.age`), copy the result to the server, then follow
[Restore](#restore). An rclone `crypt` remote wrapping the Storage Box also works, but its password then lives on
the server, so anyone with root there can read every copy.

and uncomment `Environment=OFFSITE_HOOK=/usr/local/bin/ooohm-offsite` in the service file (then
`daemon-reload`). The hook prunes the remote copies itself. Anything else that keeps a copy keeps the data too:
give Storage Box snapshots a retention of at most 30 days, or a deleted person outlives the promise there. Also
turn on Hetzner's server backups for whole-disk recovery (they keep seven slots, so they stay inside the limit).

### Restore

Restore into a **new** database, check it, then switch. Never restore over the live one.

```bash
ooohm exec db createdb -U ooohm ooohm_restore
/srv/ooohm/deploy/restore.sh /var/backups/ooohm/ooohm-<stamp>.dump.gz ooohm_restore --yes
ooohm exec db psql -U ooohm -d ooohm_restore -c "select count(*) from \"user\"; select count(*) from leave_requests;"
```

To switch over: stop the writers, swap the names, start again.

```bash
ooohm stop app worker
ooohm exec db psql -U ooohm -d postgres -c "alter database ooohm rename to ooohm_before_restore" \
                                         -c "alter database ooohm_restore rename to ooohm"
ooohm up -d
```

Drop `ooohm_before_restore` once you are sure. Practise this once before cutover (the restore was tested against
a full import: every table's row count matched after a backup and restore).

## 14. Upgrades (10 min)

```bash
cd /srv/ooohm
/srv/ooohm/deploy/backup.sh                 # always, before any upgrade
git rev-parse HEAD > ~/ooohm-previous-version
git fetch && git checkout <new tag or commit>
ooohm up -d --build
ooohm ps && curl -sS https://ooohm.team/api/health
```

`migrate` runs before the new app starts, so new migrations are applied automatically. The worker finishes
in-flight webhook deliveries on shutdown (30-second grace). Expect a few seconds of 502 from Caddy while the app
container is replaced.

## 15. Rollback (10 min)

If the new version misbehaves:

- **No new migration in the release** (check `git diff <previous>..HEAD -- drizzle/`): check out the previous
  version and rebuild.

  ```bash
  git checkout "$(cat ~/ooohm-previous-version)"
  ooohm up -d --build
  ```

- **The release added a migration**: migrations only go forward, and old code may not run against the new
  schema. Restore the backup taken before the upgrade (step 13), with the previous version checked out. Anything
  written since that backup is lost, so decide quickly.

## 16. Logs and day-to-day

```bash
ooohm ps                                   # health of every service
ooohm logs -f --tail=100 app worker        # JSON lines: time, level, event, ids
ooohm logs --since=1h app | grep '"level":"error"'
ooohm logs -f caddy                        # access log (no query strings or feed tokens)
ooohm exec db psql -U ooohm -d ooohm       # a SQL shell
ooohm run --rm migrate pnpm job:rollover   # the year rollover by hand (the worker runs it daily)
```

With `jq` installed, `ooohm logs --no-log-prefix app | jq -c 'select(.level=="error")'` filters errors.

## 17. Cutover checklist

The milestone is done when all of these hold:

- [ ] `https://ooohm.team` serves over HTTPS with a valid certificate; `/api/health` answers `{"status":"ok"}`.
- [ ] Sign-in email arrives within a minute and passes SPF, DKIM and DMARC.
- [ ] Backups run nightly, are copied off the server, and one restore drill has been done.
- [ ] **Every person's balance matches TimeOff**: the applied import reported `Diff 0` for every current-year row,
      and three people were spot-checked by hand against TimeOff's screens.
- [ ] **Everyone has requested time off once and had it approved** in OOOhm (a real request, or a half day
      they then cancel). Keep a list; it proves each person can sign in and each approval route works.
- [ ] The team calendar feed shows in Google Calendar.
- [ ] **TimeOff.Management is shut down**: its service stopped and disabled, its DNS record removed or pointed at
      OOOhm, and its final SQLite file archived (encrypted) with the import report. Delete
      `/srv/ooohm-import/timeoff.sqlite` from the OOOhm server.
- [ ] The ClickUp task for M7 is set to its terminal status, and `LIVE: ooohm.team` is posted in the client
      channel.

## Trying the production stack locally

Everything above can be rehearsed on a laptop with Docker. Use `OOOHM_DOMAIN=localhost` (Caddy then issues a
certificate from its own local CA), `BETTER_AUTH_URL=https://localhost:18443`, `HTTP_PORT=18080`,
`HTTPS_PORT=18443`, and a separate project name so nothing clashes with the development stack:

```bash
docker compose -p ooohm-prodtest --env-file .env.prodtest -f deploy/docker-compose.prod.yml up -d --build --wait
curl -sk https://localhost:18443/api/health
docker compose -p ooohm-prodtest --env-file .env.prodtest -f deploy/docker-compose.prod.yml down -v
```

Mail needs a real SMTP server here (there is no Mailpit in the production file); for a rehearsal, add a mail
catcher in a separate compose override on the `backend` network and point `SMTP_HOST` at it.

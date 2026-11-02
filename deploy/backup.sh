#!/usr/bin/env bash
# Backs up the OOOhm database: pg_dump in custom format, gzipped, timestamped, with
# old backups pruned. Run it from cron or the systemd timer in deploy/systemd/.
#
#   deploy/backup.sh
#
# Settings (environment):
#   BACKUP_DIR        where backups go             (default /var/backups/ooohm)
#   RETENTION_DAYS    the most days a backup is kept (default 30, at most 30): after
#                     each run no local backup is older than this. Exported, so
#                     OFFSITE_HOOK can prune its copies to the same limit. It is what
#                     bounds how long a deleted person's data survives in backups, which
#                     the delete dialog promises is 30 days at most.
#   OOOHM_DIR         the repository checkout      (default: this script's parent)
#   ENV_FILE          compose env file             (default $OOOHM_DIR/.env.production)
#   PG_DUMP           the dump command; it must write a custom-format dump to stdout
#                     (default: pg_dump inside the compose `db` service)
#   OFFSITE_HOOK      optional command run with the new file's path as its only
#                     argument, to copy it off the server, e.g.
#                     OFFSITE_HOOK=/usr/local/bin/ooohm-offsite (docs/deploy.md). The
#                     dump holds personal data and sign-in rows: the hook must
#                     encrypt it before it leaves the server.
#
# Exits non-zero, keeping older backups, when the dump or the hook fails.
set -euo pipefail

OOOHM_DIR=${OOOHM_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/ooohm}
RETENTION_DAYS=${RETENTION_DAYS:-30}
ENV_FILE=${ENV_FILE:-$OOOHM_DIR/.env.production}
PG_DUMP=${PG_DUMP:-docker compose --env-file "$ENV_FILE" -f "$OOOHM_DIR/deploy/docker-compose.prod.yml" exec -T db pg_dump -U ooohm -d ooohm}

case $RETENTION_DAYS in
  '' | *[!0-9]* | 0) echo "RETENTION_DAYS must be a whole number of days, from 1 to 30." >&2; exit 2 ;;
esac
if [ "$((10#$RETENTION_DAYS))" -gt 30 ]; then
  echo "RETENTION_DAYS must be a whole number of days, from 1 to 30: deleted people's data must not outlive 30 days in backups." >&2
  exit 2
fi
export RETENTION_DAYS

# Dumps hold every person's data: readable by the owner only.
umask 077
mkdir -p "$BACKUP_DIR"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$BACKUP_DIR/ooohm-$stamp.dump.gz"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT INT TERM

# -Fc: custom format (pg_restore can restore single tables, in parallel, and --clean).
# -Z 0 leaves compression to gzip, so the file is one plain gzip stream.
# shellcheck disable=SC2086 # PG_DUMP is a command line on purpose.
if ! eval "$PG_DUMP -Fc -Z 0" | gzip -9 >"$partial"; then
  echo "backup failed: pg_dump or gzip exited with an error" >&2
  exit 1
fi
gzip -t "$partial"
# A custom-format dump starts with "PGDMP"; anything else (an error page, an empty pipe) is not a backup.
if [ "$(gzip -dc "$partial" | head -c 5)" != "PGDMP" ]; then
  echo "backup failed: the dump is empty or not in custom format" >&2
  exit 1
fi
mv "$partial" "$file"
trap - EXIT INT TERM
echo "backup written: $file ($(wc -c <"$file" | tr -d ' ') bytes)"

if [ -n "${OFFSITE_HOOK:-}" ]; then
  # shellcheck disable=SC2086
  if ! eval "$OFFSITE_HOOK \"\$file\""; then
    echo "off-site copy failed for $file" >&2
    exit 1
  fi
  echo "off-site copy done"
fi

# Prune only our own files, and only after a good backup exists. Minutes, not -mtime:
# `-mtime +30` matches only files at least 31 whole days old, so backups lived 31 to 32
# days. Deleting what is older than RETENTION_DAYS less an hour (the margin absorbs the
# timer's start-time jitter) means the run on the day a backup turns RETENTION_DAYS old
# removes it. -mmin works the same in GNU and BSD find.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ooohm-*.dump.gz' -mmin +"$((RETENTION_DAYS * 1440 - 60))" -print -delete

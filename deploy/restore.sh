#!/usr/bin/env bash
# Restores an OOOhm backup made by deploy/backup.sh into a database.
#
#   deploy/restore.sh <backup.dump.gz> <database> --yes
#
# The target database must exist and be empty; restore into a fresh one, check it,
# then switch over (docs/deploy.md, "Restore"). Restoring over the live database is
# not offered: a failed restore halfway would leave neither copy intact.
#
# Settings (environment):
#   OOOHM_DIR, ENV_FILE  as in backup.sh
#   PG_RESTORE           the restore command; it reads the dump on stdin and gets
#                        the database name appended (default: pg_restore inside the
#                        compose `db` service, as the ooohm user)
set -euo pipefail

if [ $# -ne 3 ] || [ "$3" != "--yes" ]; then
  echo "Usage: $0 <backup.dump.gz> <database> --yes" >&2
  exit 2
fi
file=$1
database=$2
case $database in
  '' | *[!a-z0-9_]*) echo "Database names here are lowercase letters, digits and _." >&2; exit 2 ;;
esac

OOOHM_DIR=${OOOHM_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
ENV_FILE=${ENV_FILE:-$OOOHM_DIR/.env.production}
PG_RESTORE=${PG_RESTORE:-docker compose --env-file "$ENV_FILE" -f "$OOOHM_DIR/deploy/docker-compose.prod.yml" exec -T db pg_restore -U ooohm --no-owner --exit-on-error -d}

gzip -t "$file"
# shellcheck disable=SC2086
gzip -dc "$file" | eval "$PG_RESTORE $database"
echo "restored $file into $database"

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
if [ -z "$BACKUP_FILE" ] || [ -z "$RESTORE_DATABASE_URL" ] || [ -z "$AGE_IDENTITY_FILE" ] || [ "$CONFIRM_RESTORE_TARGET" != "disposable" ]; then
  echo "Set BACKUP_FILE, RESTORE_DATABASE_URL, AGE_IDENTITY_FILE and CONFIRM_RESTORE_TARGET=disposable" >&2; exit 1
fi
case "$BACKUP_FILE" in *.dump.age) ;; *) echo "Expected encrypted .dump.age file" >&2; exit 1 ;; esac
command -v age >/dev/null && command -v pg_restore >/dev/null && command -v psql >/dev/null || { echo "age, pg_restore and psql are required" >&2; exit 1; }
if [ -f "$BACKUP_FILE.sha256" ]; then (cd "$(dirname "$BACKUP_FILE")" && sha256sum --check "$(basename "$BACKUP_FILE").sha256"); fi
tmp="$(mktemp /tmp/shuleledger-restore.XXXXXX.dump)"; chmod 600 "$tmp"; trap 'rm -f "$tmp"' EXIT
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$tmp" "$BACKUP_FILE"
test -s "$tmp"
pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error --dbname "$RESTORE_DATABASE_URL" "$tmp"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT 'schools=' || count(*) FROM schools"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT 'journals=' || count(*) FROM journal_entries"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT 'migrations=' || count(*) FROM schema_migrations"
echo "Restore drill completed. Verify balances, allocations, tenant isolation, login and reports before recording a pass."

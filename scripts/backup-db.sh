#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
if [ -z "$DATABASE_URL" ] || [ -z "$BACKUP_DIR" ] || [ -z "$BACKUP_AGE_RECIPIENT" ]; then
  echo "DATABASE_URL, BACKUP_DIR and BACKUP_AGE_RECIPIENT are required" >&2; exit 1
fi
command -v pg_dump >/dev/null || { echo "pg_dump is required" >&2; exit 1; }
command -v age >/dev/null || { echo "age is required" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$(mktemp "$BACKUP_DIR/.shuleledger-$stamp.XXXXXX.dump")"
encrypted="$BACKUP_DIR/shuleledger-$stamp.dump.age"
trap 'rm -f "$tmp"' EXIT
pg_dump --format=custom --no-owner --no-acl --lock-wait-timeout=30s "$DATABASE_URL" > "$tmp"
test -s "$tmp"
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted" "$tmp"
chmod 600 "$encrypted"
sha256sum "$encrypted" > "$encrypted.sha256"; chmod 600 "$encrypted.sha256"
printf 'backup=%s\ncreated_utc=%s\n' "$(basename "$encrypted")" "$stamp" > "$encrypted.manifest"
chmod 600 "$encrypted.manifest"
rm -f "$tmp"; trap - EXIT
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'shuleledger-*.dump.age' -printf '%T@ %p\n' | sort -nr | tail -n +31 | cut -d' ' -f2- | while IFS= read -r old; do rm -f -- "$old" "$old.sha256" "$old.manifest"; done
printf 'Encrypted backup created: %s\n' "$encrypted"

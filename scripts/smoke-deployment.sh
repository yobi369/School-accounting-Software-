#!/usr/bin/env bash
set -Eeuo pipefail
if [ -z "${PRODUCTION_BASE_URL:-}" ]; then
  echo "PRODUCTION_BASE_URL must be the HTTPS origin of the deployed application." >&2
  exit 2
fi
case "$PRODUCTION_BASE_URL" in
  https://*) ;;
  *) echo "Production smoke tests require HTTPS." >&2; exit 2 ;;
esac
base="${PRODUCTION_BASE_URL%/}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl --fail --silent --show-error --max-time 15 "$base/health" -o "$tmp/health.json"
curl --fail --silent --show-error --max-time 15 "$base/ready" -o "$tmp/ready.json"
curl --fail --silent --show-error --max-time 15 -D "$tmp/headers.txt" "$base/api/v1/status" -o "$tmp/status.json"
node --input-type=module - "$tmp" <<'NODE'
import { readFileSync } from 'node:fs';
const dir = process.argv[2];
const health = JSON.parse(readFileSync(dir + '/health.json', 'utf8'));
const ready = JSON.parse(readFileSync(dir + '/ready.json', 'utf8'));
const status = JSON.parse(readFileSync(dir + '/status.json', 'utf8'));
const headers = readFileSync(dir + '/headers.txt', 'utf8').toLowerCase();
const failures = [];
if (health.status !== 'ok') failures.push('liveness endpoint did not return status=ok');
if (ready.status !== 'ready') failures.push('database readiness endpoint did not return status=ready');
if (status.databaseConfigured !== true) failures.push('API reports no configured database');
if (status.runtimeDatabaseRoleVerified !== true) failures.push('runtime database role is not verified as least-privilege');
if (process.env.REQUIRE_PRODUCTION_ATTESTATION === 'true' && status.productionReady !== true) failures.push('API has not declared production readiness');
for (const header of ['x-content-type-options: nosniff', 'x-frame-options: deny', 'cache-control: no-store']) {
  if (!headers.includes(header)) failures.push('missing security header: ' + header);
}
if (failures.length) {
  console.error('Production smoke test FAILED:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('Deployment smoke test passed: HTTPS, liveness, database readiness, least-privilege runtime role, and security headers.');
if (status.productionReady !== true) console.log('Production readiness remains blocked pending independent acceptance and recovery sign-off.');
NODE

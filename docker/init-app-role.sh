#!/bin/sh
set -eu

: "${SHULELEDGER_APP_PASSWORD:?SHULELEDGER_APP_PASSWORD must be set}"

# This runs only when PostgreSQL initializes a brand-new data directory.
# The app role deliberately cannot bypass row-level security.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 --set=app_password="$SHULELEDGER_APP_PASSWORD" <<'SQL'
CREATE ROLE shuleledger_app
  LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE shuleledger TO shuleledger_app;
SQL

#!/bin/sh
set -eu
# This role can only read the two routing views. No application table access.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=pw="$POSTFIX_PASSWORD" <<'SQL'
CREATE ROLE postfix LOGIN PASSWORD :'pw';
GRANT CONNECT ON DATABASE inboxlab TO postfix;
GRANT USAGE ON SCHEMA public TO postfix;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL

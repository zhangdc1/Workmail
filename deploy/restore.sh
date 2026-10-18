#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
[[ "${1:-}" != "" ]] || { echo "Usage: bash deploy/restore.sh /absolute/path/to/backup"; exit 1; }
snapshot=$(realpath "$1")
[[ "$snapshot" != / ]] || exit 1
exec 9>runtime-backup.lock
flock -n 9 || { echo "Another maintenance job is active"; exit 1; }
for name in database.dump mail.tar.gz manifest.txt SHA256SUMS; do
  [[ -f "$snapshot/$name" && ! -L "$snapshot/$name" ]] || { echo "Invalid backup file: $name"; exit 1; }
done
declare -A verified_files=()
while IFS= read -r line; do
  [[ "$line" =~ ^[[:xdigit:]]{64}[[:space:]][[:space:]](database[.]dump|mail[.]tar[.]gz|manifest[.]txt)$ ]] || { echo "Invalid checksum manifest"; exit 1; }
  name="${BASH_REMATCH[1]}"
  [[ -z "${verified_files[$name]+exists}" ]] || { echo "Duplicate checksum entry"; exit 1; }
  verified_files[$name]=1
done < "$snapshot/SHA256SUMS"
[[ "${#verified_files[@]}" = 3 ]] || { echo "Incomplete checksum manifest"; exit 1; }
(cd "$snapshot"; sha256sum -c SHA256SUMS)
dc() { docker compose --env-file .env.production "$@"; }
dc up -d postgres
until dc exec -T postgres pg_isready -U inboxlab -d inboxlab >/dev/null; do sleep 2; done
# Only restore to a fresh database and an empty mail directory. Never erase data.
tables=$(dc exec -T postgres psql -U inboxlab -d inboxlab -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
[[ "$tables" = 0 ]] || { echo "Target database is not empty. Use a fresh deployment directory/project."; exit 1; }
mkdir -p runtime/mail
[[ -z "$(find runtime/mail -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo "Target mail directory must be empty"; exit 1; }
# Treat archive names as data, never allow absolute or traversal paths.
if ! tar -tzf "$snapshot/mail.tar.gz" | awk '/(^\/|(^|\/)\.\.(\/|$))/ {bad=1} END {exit bad}'; then echo "Invalid archive paths"; exit 1; fi
if ! tar -tvzf "$snapshot/mail.tar.gz" | awk 'substr($0,1,1)!~/[-d]/ {bad=1} END {exit bad}'; then echo "Archive must contain only regular files and directories"; exit 1; fi
tar --numeric-owner -C runtime/mail -xzf "$snapshot/mail.tar.gz"
dc exec -T postgres pg_restore --exit-on-error --no-owner -U inboxlab -d inboxlab < "$snapshot/database.dump"
dc exec -T postgres psql -v ON_ERROR_STOP=1 -U inboxlab -d inboxlab < deploy/grant-postfix.sql
echo "Restore loaded. Ensure ENCRYPTION_KEY matches the source, run migrations, then start services."

#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
root=$(pwd -P)
destination="${BACKUP_DIR:-$root/backups}"
mkdir -p "$destination"
destination=$(realpath "$destination")
[[ "$destination" != / && "$destination" != "$root" ]] || { echo "Invalid backup destination"; exit 1; }
exec 9>"$root/runtime-backup.lock"
flock -n 9 || { echo "Another maintenance job is active"; exit 1; }
dc() { docker compose --env-file .env.production "$@"; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$destination/daily" "$destination/weekly"
temp="$destination/daily/.partial-$stamp"
mkdir -m 700 "$temp"
running=()
for service in api smtp worker; do
  if [[ -n "$(dc ps --status running -q "$service")" ]]; then running+=("$service"); fi
done
resume() { if ((${#running[@]})); then dc start "${running[@]}" >/dev/null; fi; }
trap resume EXIT
# Public Postfix stays online and queues during this short consistency window.
if ((${#running[@]})); then dc stop -t 100 "${running[@]}"; fi
dc exec -T postgres pg_dump -U inboxlab -d inboxlab -Fc > "$temp/database.dump"
tar --numeric-owner -C runtime/mail -czf "$temp/mail.tar.gz" .
printf 'format=1\ncreated_utc=%s\nproject=inboxlab\n' "$stamp" > "$temp/manifest.txt"
(cd "$temp"; sha256sum database.dump mail.tar.gz manifest.txt > SHA256SUMS)
mv -- "$temp" "$destination/daily/$stamp"
resume; running=()
if [[ "$(date -u +%u)" = 7 ]]; then cp -al "$destination/daily/$stamp" "$destination/weekly/$stamp"; fi
prune() {
  local directory="$1" keep="$2"
  local entries=()
  mapfile -t entries < <(find "$directory" -mindepth 1 -maxdepth 1 -type d -name '20*T*Z' -printf '%f\n' | sort -r)
  for ((i=keep;i<${#entries[@]};i++)); do
    [[ "${entries[i]}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || exit 1
    rm -rf -- "$directory/${entries[i]}"
  done
}
prune "$destination/daily" 7
prune "$destination/weekly" 4
echo "Backup verified: $destination/daily/$stamp"
echo "Encryption key is NOT in this backup. Keep .env.production/key in a separate secure location."

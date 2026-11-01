#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
SCOPE="${ICT_G3_SCOPE:-isolated}"
OUTPUT_ROOT="${ICT_G3_BACKUP_DIR:-$ROOT/.tmp}"
PG_BIN_DIR="${ICT_PG_BIN_DIR:-}"
[[ "$MODE" == --check || "$MODE" == --run ]] || { echo "usage: DATABASE_URL=... [ICT_PG_BIN_DIR=/pg16/bin] $0 {--check|--run}" >&2; exit 2; }
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
if [[ -n "$PG_BIN_DIR" ]]; then PG_DUMP="$PG_BIN_DIR/pg_dump"; PG_RESTORE="$PG_BIN_DIR/pg_restore"; PSQL="$PG_BIN_DIR/psql"; else PG_DUMP="$(command -v pg_dump)"; PG_RESTORE="$(command -v pg_restore)"; PSQL="$(command -v psql)"; fi
for tool in "$PG_DUMP" "$PG_RESTORE" "$PSQL"; do [[ -x "$tool" ]] || { echo 'ERROR: PostgreSQL tool unavailable' >&2; exit 1; }; done
read -r DB_HOST DB_NAME < <(python - "$DATABASE_URL" <<'PY'
from urllib.parse import urlsplit
import sys
u=urlsplit(sys.argv[1]); print(u.hostname or '',(u.path or '/').lstrip('/'))
PY
)
[[ "$DB_HOST" == 127.0.0.1 || "$DB_HOST" == localhost ]] || { echo 'ERROR: local PostgreSQL required' >&2; exit 1; }
if [[ "$SCOPE" == production ]]; then
  [[ "$DB_NAME" == project_manager && "${ICT_G3_PRODUCTION_CONFIRM:-}" == ICT-G3-DIFFERENTIAL-BACKUP-AUTHORIZED && "${ICT_G3_AUTHORIZED_SESSION:-}" =~ ^session-[0-9a-f-]+$ ]] || { echo 'ERROR: production backup authorization missing' >&2; exit 1; }
else
  [[ "$SCOPE" == isolated && "$DB_NAME" =~ ^ict_g3_differential_source_[0-9]+_[0-9]+$ ]] || { echo 'ERROR: unsafe isolated source database' >&2; exit 1; }
fi
server_version="$($PSQL "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select current_setting('server_version')")"; server_major="${server_version%%.*}"
dump_version="$($PG_DUMP --version)"; restore_version="$($PG_RESTORE --version)"
dump_major="$(sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/' <<<"$dump_version")"; restore_major="$(sed -E 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/' <<<"$restore_version")"
printf 'SERVER_MAJOR=%s\nPG_DUMP_MAJOR=%s\nPG_RESTORE_MAJOR=%s\n' "$server_major" "$dump_major" "$restore_major"
[[ "$dump_major" == "$server_major" && "$restore_major" == "$server_major" ]] || { echo 'ERROR: PostgreSQL client/server major mismatch' >&2; exit 1; }
[[ "$MODE" == --check ]] && { echo 'DIFFERENTIAL_BACKUP_TOOL_GATE=PASS'; exit 0; }

query(){ "$PSQL" "$1" -X -qAt -v ON_ERROR_STOP=1 -c "$2"; }
baseline(){
  local url="$1"
  query "$url" "select (select count(*) from projects)||'/'||(select count(*) from tasks)||'/'||(select count(*) from knowledge_bases)||'/'||(select count(*) from opportunity.opportunities)||'/'||(select count(*) from opportunity.organizations)||'/'||(select count(*) from drizzle.__drizzle_migrations)||'/'||(select count(*) from information_schema.tables where table_schema='public' and table_name in('import_batches','import_batch_entities','import_field_changes'))||'/'||(select count(*) from information_schema.tables where table_schema='opportunity' and table_name in('import_batches','import_batch_entities','import_field_changes','import_scope_currents','import_audit_events'))||'/'||(select count(*) from information_schema.columns where table_schema='opportunity' and table_name='opportunities' and column_name in('customer_snapshot','is_current','archived_at','latest_import_batch_id'))||'/'||(select count(*) from public.import_jobs)||'/'||(select count(*) from opportunity.import_batches)||'/'||(select count(*) from opportunity.import_batch_entities)||'/'||(select count(*) from opportunity.import_field_changes)||'/'||(select count(*) from opportunity.import_scope_currents)||'/'||(select count(*) from opportunity.import_audit_events)"
}
expected='14/1015/21/64/0/20/0/5/4/268/2/128/813/1/5'
source="$(baseline "$DATABASE_URL")"; [[ "$source" == "$expected" ]] || { echo 'ERROR: source differential baseline mismatch' >&2; exit 1; }
if [[ "$SCOPE" == production ]]; then [[ "$DB_NAME" == project_manager ]] || { echo 'ERROR: production source database identity mismatch' >&2; exit 1; }; fi

stamp="$(date +%Y%m%d-%H%M%S)"; run_dir="$OUTPUT_ROOT/ict-g3-differential-restore-point-$stamp"; backup="$run_dir/project-manager-pre-differential-g3.dump"; restore_list="$run_dir/restore-list.txt"; meta="$run_dir/baseline.txt"
umask 077; mkdir -p "$OUTPUT_ROOT"; lock_dir="$OUTPUT_ROOT/.ict-g3-differential-backup.lock"; mkdir "$lock_dir" 2>/dev/null || { echo 'ERROR: another differential backup is running' >&2; exit 1; }; mkdir "$run_dir"; chmod 700 "$run_dir"
read -r admin_url restore_url restore_db < <(python - "$DATABASE_URL" <<'PY'
from urllib.parse import urlsplit,urlunsplit
import os,sys,time
u=urlsplit(sys.argv[1]); name=f'ict_g3_differential_restore_{os.getpid()}_{int(time.time())}'
print(urlunsplit((u.scheme,u.netloc,'/postgres',u.query,u.fragment)),urlunsplit((u.scheme,u.netloc,'/'+name,u.query,u.fragment)),name)
PY
)
[[ "$restore_db" =~ ^ict_g3_differential_restore_[0-9]+_[0-9]+$ && "$restore_db" != "$DB_NAME" ]] || { echo 'ERROR: unsafe restore database' >&2; exit 1; }
created=0
cleanup(){ local failed=0; if ((created)); then "$PSQL" "$admin_url" -X -q -v ON_ERROR_STOP=1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$restore_db' and pid<>pg_backend_pid()" >/dev/null 2>&1 || failed=1; "$PSQL" "$admin_url" -X -q -v ON_ERROR_STOP=1 -c "drop database if exists \"$restore_db\"" >/dev/null 2>&1 || failed=1; fi; rmdir "$lock_dir" 2>/dev/null || failed=1; ((failed==0)) || { echo 'ERROR: differential restore cleanup failed' >&2; return 1; }; }
trap 'exit 130' INT TERM; trap cleanup EXIT
"$PG_DUMP" --format=custom --no-owner --no-acl --file="$backup" "$DATABASE_URL"; "$PG_RESTORE" --list "$backup" > "$restore_list"
"$PSQL" "$admin_url" -X -q -v ON_ERROR_STOP=1 -c "create database \"$restore_db\""; created=1
"$PG_RESTORE" --no-owner --no-acl --exit-on-error --dbname="$restore_url" "$backup"
restored="$(baseline "$restore_url")"; [[ "$restored" == "$source" ]] || { echo 'ERROR: restored differential baseline mismatch' >&2; exit 1; }
sha="$(sha256sum "$backup"|awk '{print $1}')"; bytes="$(stat -c %s "$backup")"; entries="$(grep -cvE '^;|^$' "$restore_list")"
cat > "$meta" <<EOF
restore_point_status=verified
restore_point_kind=differential-g3
created_at=$(date -Iseconds)
server_major=$server_major
pg_dump_version=$dump_version
pg_restore_version=$restore_version
source_database=$DB_NAME
source_baseline=$source
restored_baseline=$restored
backup_file=$(basename "$backup")
backup_bytes=$bytes
backup_sha256=$sha
restore_list_entries=$entries
sensitive_values_recorded=false
EOF
chmod 600 "$backup" "$restore_list" "$meta"; cleanup; created=0; trap - EXIT
printf 'DIFFERENTIAL_RESTORE_POINT=VERIFIED\nRUN_DIR=%s\nBACKUP_BYTES=%s\nBACKUP_SHA256=%s\nRESTORED_BASELINE=%s\n' "$run_dir" "$bytes" "$sha" "$restored"

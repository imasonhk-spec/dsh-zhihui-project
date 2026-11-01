#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPP_ROOT="${OPPORTUNITY_ROOT:-$(cd "$ROOT/../bussiness-manager" && pwd)}"
MODE="${1:-}"
SCOPE="${ICT_G3_SCOPE:-isolated}"
RESTORE_POINT="${ICT_G3_RESTORE_POINT:-}"
AUDIT_DIR="${ICT_G3_AUDIT_DIR:-$ROOT/.tmp}"
AUDIT_DIR="$(realpath -m "$AUDIT_DIR")"
[[ "$AUDIT_DIR" == "$ROOT/.tmp" ]] || { echo 'ERROR: G3 audit directory must be the managed project .tmp directory' >&2; exit 1; }
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
PSQL="${ICT_PG_BIN_DIR:+$ICT_PG_BIN_DIR/}psql"
[[ "$PSQL" == */psql ]] || PSQL="$(command -v psql)"
[[ -x "$PSQL" ]] || { echo "ERROR: psql is not executable: $PSQL" >&2; exit 1; }

usage() {
  echo "usage: ICT_G3_SCOPE=isolated|production ICT_G3_RESTORE_POINT=/verified/run DATABASE_URL=... $0 {--preflight|--apply|--rollback-empty}" >&2
  exit 2
}
[[ "$MODE" == "--preflight" || "$MODE" == "--apply" || "$MODE" == "--rollback-empty" ]] || usage
[[ "$SCOPE" == "isolated" || "$SCOPE" == "production" ]] || usage
RESTORE_POINT="$(realpath -e "$RESTORE_POINT" 2>/dev/null || true)"
[[ "$RESTORE_POINT" == "$ROOT"/.tmp/ict-g3-restore-point-* ]] || { echo 'ERROR: restore point must be under the managed project .tmp directory' >&2; exit 1; }

read -r DB_HOST DB_NAME < <(python - "$DATABASE_URL" <<'PY'
from urllib.parse import urlsplit
import sys
u=urlsplit(sys.argv[1]); print(u.hostname or '', (u.path or '/').lstrip('/'))
PY
)
[[ "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" ]] || { echo 'ERROR: G3 runner requires local PostgreSQL' >&2; exit 1; }
[[ -n "$DB_NAME" && "$DB_NAME" != "postgres" ]] || { echo 'ERROR: unsafe database name' >&2; exit 1; }
if [[ "$SCOPE" == "isolated" ]]; then
  [[ "$DB_NAME" =~ ^ict_g3_(exercise|release_test|post_verify)_[0-9]+_[0-9]+$ ]] || { echo "ERROR: isolated database name is not allowed: $DB_NAME" >&2; exit 1; }
else
  [[ "$DB_NAME" == "${ICT_G3_PRODUCTION_DATABASE_NAME:-project_manager}" ]] || { echo 'ERROR: production database name mismatch' >&2; exit 1; }
  [[ "${ICT_G3_PRODUCTION_CONFIRM:-}" == 'ICT-G3-PRODUCTION-AUTHORIZED' ]] || { echo 'ERROR: production confirmation phrase missing' >&2; exit 1; }
  [[ "${ICT_G3_AUTHORIZED_SESSION:-}" =~ ^session-[0-9a-f-]+$ ]] || { echo 'ERROR: authorized session id missing' >&2; exit 1; }
  [[ -r "$RESTORE_POINT/baseline.txt" && -r "$RESTORE_POINT/project-manager-pre-g3.dump" && -r "$RESTORE_POINT/restore-list.txt" ]] || { echo 'ERROR: restore point files missing' >&2; exit 1; }
  deployment_manifest="$(realpath -e "${ICT_G3_DEPLOYMENT_MANIFEST:-}" 2>/dev/null || true)"
  [[ "$deployment_manifest" == "$ROOT"/.tmp/ict-g3-*/deployment-sha256.txt && -f "$deployment_manifest" && ! -L "$deployment_manifest" ]] || { echo 'ERROR: managed deployment manifest missing' >&2; exit 1; }
  [[ "$(stat -c %u "$deployment_manifest")" == "$UID" && $((8#$(stat -c %a "$deployment_manifest") & 8#022)) == 0 ]] || { echo 'ERROR: deployment manifest metadata unsafe' >&2; exit 1; }
  (cd "$ROOT" && tail -n +3 "$deployment_manifest" | sha256sum -c - >/dev/null) || { echo 'ERROR: deployment manifest checksum mismatch' >&2; exit 1; }
  deployment_manifest_sha="$(sha256sum "$deployment_manifest" | awk '{print $1}')"
  umask 077
  mkdir -p "$AUDIT_DIR"
  audit_file="$AUDIT_DIR/ict-g3-production-$(date +%Y%m%d-%H%M%S).audit"
  {
    echo "started_at=$(date -Iseconds)"
    echo "mode=$MODE"
    echo "scope=production"
    echo "authorized_session=$ICT_G3_AUTHORIZED_SESSION"
    echo "deployment_manifest=$(basename "$deployment_manifest")"
    echo "deployment_manifest_sha256=$deployment_manifest_sha"
    echo "restore_point=$RESTORE_POINT"
    echo "restore_point_sha256=$(sha256sum "$RESTORE_POINT/project-manager-pre-g3.dump" | awk '{print $1}')"
    echo "project_migration_sha256=$(sha256sum "$ROOT/database/migrations/0021_project_import_change_tracking.sql" | awk '{print $1}')"
    echo "opportunity_migration_sha256=$(sha256sum "$OPP_ROOT/database/0005_opportunity_import_change_tracking.sql" | awk '{print $1}')"
    echo "rollback_sha256=$(sha256sum "$ROOT/database/rollback/0021_0005_empty_only.sql" | awk '{print $1}')"
  } > "$audit_file"
  chmod 600 "$audit_file"
  echo "AUDIT_FILE=$audit_file"
fi

baseline() {
  "$PSQL" "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select (select count(*) from projects)||'/'||(select count(*) from tasks)||'/'||(select count(*) from knowledge_bases)||'/'||(select count(*) from opportunity.opportunities)||'/'||(select count(*) from drizzle.__drizzle_migrations)||'/'||(select count(*) from information_schema.tables where (table_schema='public' and table_name in('import_batches','import_batch_entities','import_field_changes')) or (table_schema='opportunity' and table_name in('import_batches','import_batch_entities','import_field_changes','import_scope_currents','import_audit_events')))"
}

verify_restore_point() {
  [[ -d "$RESTORE_POINT" && -r "$RESTORE_POINT/baseline.txt" && -r "$RESTORE_POINT/project-manager-pre-g3.dump" ]] || { echo 'ERROR: verified restore point files missing' >&2; return 1; }
  grep -Fxq 'restore_point_status=verified' "$RESTORE_POINT/baseline.txt" || { echo 'ERROR: restore point is not verified' >&2; return 1; }
  local expected actual
  expected="$(sed -n 's/^backup_sha256=//p' "$RESTORE_POINT/baseline.txt")"
  actual="$(sha256sum "$RESTORE_POINT/project-manager-pre-g3.dump" | awk '{print $1}')"
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$actual" == "$expected" ]] || { echo 'ERROR: restore point checksum mismatch' >&2; return 1; }
  grep -Fxq 'source_baseline=14/1015/21/0/20/0' "$RESTORE_POINT/baseline.txt" || { echo 'ERROR: restore point source baseline mismatch' >&2; return 1; }
  grep -Fxq 'restored_baseline=14/1015/21/0/20/0' "$RESTORE_POINT/baseline.txt" || { echo 'ERROR: restore point restored baseline mismatch' >&2; return 1; }
  if [[ "$SCOPE" == production && "$MODE" != '--rollback-empty' ]]; then
    local created_epoch now_epoch
    created_epoch="$(date -d "$(sed -n 's/^created_at=//p' "$RESTORE_POINT/baseline.txt")" +%s 2>/dev/null || true)"
    now_epoch="$(date +%s)"
    [[ "$created_epoch" =~ ^[0-9]+$ && $((now_epoch-created_epoch)) -ge 0 && $((now_epoch-created_epoch)) -le 86400 ]] || { echo 'ERROR: verified restore point is older than 24 hours' >&2; return 1; }
  fi
  echo 'RESTORE_POINT_GATE=PASS'
}

verify_pre_state() {
  local value
  value="$(baseline)"
  echo "PRE_G3_BASELINE=$value"
  [[ "$value" == '14/1015/21/0/20/0' ]] || { echo 'ERROR: database is not at approved pre-G3 baseline' >&2; return 1; }
}

verify_post_state() {
  local value rows columns
  value="$(baseline)"
  rows="$($PSQL "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select (select count(*) from import_batches)+(select count(*) from import_batch_entities)+(select count(*) from import_field_changes)+(select count(*) from opportunity.import_batches)+(select count(*) from opportunity.import_batch_entities)+(select count(*) from opportunity.import_field_changes)+(select count(*) from opportunity.import_scope_currents)+(select count(*) from opportunity.import_audit_events)")"
  columns="$($PSQL "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select count(*) from information_schema.columns where table_schema='opportunity' and table_name='opportunities' and column_name in('customer_snapshot','is_current','archived_at','latest_import_batch_id')")"
  printf 'POST_G3_BASELINE=%s\nPOST_G3_ICT_ROWS=%s\nPOST_G3_OPPORTUNITY_COLUMNS=%s\n' "$value" "$rows" "$columns"
  [[ "$value" == '14/1015/21/0/21/8' && "$rows" == 0 && "$columns" == 4 ]] || { echo 'ERROR: post-G3 structure or empty-ledger gate failed' >&2; return 1; }
}

units=(project-manager-web.service opportunity-manager-web.service project-manager-api.service opportunity-manager-api.service)
ports=(3200 3210 3100 3211)
services_frozen=0
freeze_services() {
  [[ "$SCOPE" == production ]] || return 0
  services_frozen=1
  systemctl --user stop "${units[@]}" || true
  local unit port pid
  for unit in "${units[@]}"; do
    pid="$(systemctl --user show "$unit" -p MainPID --value)"
    [[ "$pid" == 0 ]] || { echo "ERROR: service still has PID: $unit/$pid" >&2; return 1; }
  done
  for port in "${ports[@]}"; do
    ! ss -ltn | awk '{print $4}' | grep -Eq "(^|:)$port$" || { echo "ERROR: port remains listening: $port" >&2; return 1; }
  done
  services_frozen=1
  echo 'SERVICE_FREEZE_GATE=PASS'
}

health() {
  local url="$1" expected="$2" ready=0 code='000'
  for _ in $(seq 1 60); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)"
    [[ "$code" == "$expected" ]] && { ready=1; break; }
    sleep 0.5
  done
  echo "$url=$code"
  [[ "$ready" == 1 ]]
}

start_services() {
  [[ "$SCOPE" == production ]] || return 0
  systemctl --user reset-failed "${units[@]}" || true
  systemctl --user start project-manager-api.service opportunity-manager-api.service
  health http://127.0.0.1:3100/health 200
  health http://127.0.0.1:3211/health 200
  systemctl --user start project-manager-web.service opportunity-manager-web.service
  health http://127.0.0.1:3200 200
  health http://127.0.0.1:3210 200
  services_frozen=0
  echo 'SERVICE_START_GATE=PASS'
}

rollback_empty() {
  PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120s' "$PSQL" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$ROOT/database/rollback/0021_0005_empty_only.sql"
  [[ "$(baseline)" == '14/1015/21/0/20/0' ]] || { echo 'ERROR: rollback baseline mismatch' >&2; return 1; }
  echo 'EMPTY_STRUCTURE_ROLLBACK=PASS'
}

audit_finished=0
finish_audit() {
  [[ "$SCOPE" == production && -n "${audit_file:-}" && -f "$audit_file" && "$audit_finished" == 0 ]] || return 0
  {
    echo "finished_at=$(date -Iseconds)"
    echo "final_status=$1"
    echo "final_baseline=$(baseline 2>/dev/null || echo unavailable)"
  } >> "$audit_file"
  chmod 600 "$audit_file"
  audit_finished=1
}

mutated=0
failure_handler() {
  local code=$?
  trap - EXIT
  if (( code == 0 )); then exit 0; fi
  if [[ "$MODE" == '--rollback-empty' ]]; then
    if (( services_frozen == 1 )); then
      finish_audit failed_manual_intervention
      echo 'ROLLBACK_REFUSED_OR_FAILED: manual intervention required; services remain frozen' >&2
    else
      finish_audit failed_before_migration
    fi
    exit "$code"
  fi
  if (( mutated == 1 )); then
    echo 'APPLY_FAILED: re-freezing services before protected empty-ledger rollback' >&2
    if ! freeze_services; then
      finish_audit failed_manual_intervention
      echo 'RE_FREEZE_FAILED: structure rollback prohibited; manual intervention required' >&2
      exit "$code"
    fi
    if ! rollback_empty; then
      finish_audit failed_manual_intervention
      echo 'ROLLBACK_REFUSED_OR_FAILED: manual intervention required; services remain frozen' >&2
      exit "$code"
    fi
    finish_audit failed_rolled_back
  else
    finish_audit failed_before_migration
  fi
  if (( services_frozen == 1 )); then start_services || true; fi
  exit "$code"
}

trap failure_handler EXIT
verify_restore_point
if [[ "$MODE" == '--rollback-empty' ]]; then
  freeze_services
  rollback_empty
  start_services
  finish_audit empty_structure_rollback_pass
  trap - EXIT
  exit 0
fi
verify_pre_state
if [[ "$MODE" == '--preflight' ]]; then
  finish_audit preflight_pass
  echo 'G3_PREFLIGHT=PASS'
  exit 0
fi

freeze_services
verify_pre_state
pending_project_migrations="$($PSQL "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select 21-(select count(*) from drizzle.__drizzle_migrations)")"
[[ "$pending_project_migrations" == 1 ]] || { echo 'ERROR: project pending migration set is not exactly 0021' >&2; exit 1; }
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120s' DATABASE_URL="$DATABASE_URL" pnpm --dir "$ROOT" db:migrate
mutated=1
[[ "$($PSQL "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c 'select count(*) from drizzle.__drizzle_migrations')" == 21 ]]
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120s' "$PSQL" "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -1 -f "$OPP_ROOT/database/0005_opportunity_import_change_tracking.sql"
verify_post_state
if [[ "$SCOPE" == production ]]; then
  case "${IMPORT_CHANGE_TRACKING_ENABLED:-}" in
    true|TRUE|True|1|on|ON|enabled|ENABLED) ;;
    *) echo 'ERROR: IMPORT_CHANGE_TRACKING_ENABLED must be explicitly enabled before production service start' >&2; exit 1 ;;
  esac
fi
start_services
if [[ "$SCOPE" == production ]]; then
  ICT_G3_SCOPE=production \
  ICT_G3_PRODUCTION_CONFIRM="$ICT_G3_PRODUCTION_CONFIRM" \
  ICT_G3_AUTHORIZED_SESSION="$ICT_G3_AUTHORIZED_SESSION" \
  ICT_G3_EVIDENCE_DIR="$AUDIT_DIR" \
  ICT_G3_EXECUTION_AUDIT_FILE="$audit_file" \
  ICT_PG_BIN_DIR="${ICT_PG_BIN_DIR:-}" \
  DATABASE_URL="$DATABASE_URL" \
  "$ROOT/scripts/ict-g3-post-verify.sh" --all
fi
finish_audit automated_pass_edge_pending
trap - EXIT
echo 'G3_APPLY=PASS'
if [[ "$SCOPE" == production ]]; then echo 'RELEASE_STATE=READY_FOR_EDGE_G3_SMOKE'; fi

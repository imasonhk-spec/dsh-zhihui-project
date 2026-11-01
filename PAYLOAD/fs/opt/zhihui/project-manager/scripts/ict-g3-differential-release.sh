#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
SCOPE="${ICT_G3_SCOPE:-isolated}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL required}"
PSQL="${ICT_PG_BIN_DIR:+$ICT_PG_BIN_DIR/}psql"; [[ "$PSQL" == */psql ]] || PSQL="$(command -v psql)"
MIGRATION="$ROOT/database/migrations/0021_project_import_change_tracking.sql"
OPPORTUNITY_REFERENCE="/home/lgsj/harness/bussiness-manager/database/0005_opportunity_import_change_tracking.sql"
ROLLBACK="$ROOT/database/rollback/0021_public_empty_only.sql"
[[ "$MODE" == --preflight || "$MODE" == --apply || "$MODE" == --rollback-public-empty ]] || { echo "usage: $0 {--preflight|--apply|--rollback-public-empty}" >&2; exit 2; }
[[ "$SCOPE" == isolated || "$SCOPE" == production ]] || { echo 'ERROR: invalid scope' >&2; exit 2; }
read -r host name < <(python - "$DATABASE_URL" <<'PY'
from urllib.parse import urlsplit
import sys
u=urlsplit(sys.argv[1]);print(u.hostname or '',(u.path or '/').lstrip('/'))
PY
)
[[ "$host" == 127.0.0.1 || "$host" == localhost ]] || { echo 'ERROR: local PostgreSQL required' >&2; exit 1; }
if [[ "$SCOPE" == isolated ]]; then
  [[ "$name" =~ ^ict_g3_(differential|release_test|post_verify)_[0-9]+_[0-9]+$ ]] || { echo 'ERROR: unsafe isolated database' >&2; exit 1; }
else
  [[ "$name" == project_manager && "${ICT_G3_PRODUCTION_CONFIRM:-}" == ICT-G3-DIFFERENTIAL-PRODUCTION-AUTHORIZED && "${ICT_G3_AUTHORIZED_SESSION:-}" =~ ^session-[0-9a-f-]+$ ]] || { echo 'ERROR: production authorization missing' >&2; exit 1; }
  if [[ "$MODE" != --rollback-public-empty ]]; then
    echo 'ERROR: production migration is already complete; release apply/preflight is retired, use authorized post-verify' >&2
    exit 1
  fi
fi
q(){ "$PSQL" "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$1"; }
pre(){ q "select (select count(*) from projects)||'/'||(select count(*) from tasks)||'/'||(select count(*) from knowledge_bases)||'/'||(select count(*) from opportunity.opportunities)||'/'||(select count(*) from opportunity.organizations)||'/'||(select count(*) from drizzle.__drizzle_migrations)||'/'||(select count(*) from information_schema.tables where table_schema='public' and table_name in('import_batches','import_batch_entities','import_field_changes'))||'/'||(select count(*) from information_schema.tables where table_schema='opportunity' and table_name in('import_batches','import_batch_entities','import_field_changes','import_scope_currents','import_audit_events'))||'/'||(select count(*) from information_schema.columns where table_schema='opportunity' and table_name='opportunities' and column_name in('customer_snapshot','is_current','archived_at','latest_import_batch_id'))||'/'||(select count(*) from public.import_jobs)||'/'||(select count(*) from opportunity.import_batches)||'/'||(select count(*) from opportunity.import_batch_entities)||'/'||(select count(*) from opportunity.import_field_changes)||'/'||(select count(*) from opportunity.import_scope_currents)||'/'||(select count(*) from opportunity.import_audit_events)"; }
expected='14/1015/21/64/0/20/0/5/4/268/2/128/813/1/5'
post_expected='14/1015/21/64/0/21/3/5/4/268/2/128/813/1/5'
units=(project-manager-web.service opportunity-manager-web.service project-manager-api.service opportunity-manager-api.service)
ports=(3200 3210 3100 3211)
frozen=0; mutated=0; audit=""
freeze(){ if [[ "$SCOPE" != production ]]; then return 0; fi; systemctl --user stop "${units[@]}" || true; frozen=1; for u in "${units[@]}"; do [[ "$(systemctl --user show "$u" -p MainPID --value)" == 0 ]] || { echo "ERROR: service did not freeze: $u" >&2; return 1; }; done; for p in "${ports[@]}"; do ! ss -ltn | awk '{print $4}' | grep -Eq "(^|:)$p$" || { echo "ERROR: port remains listening: $p" >&2; return 1; }; done; }
start(){ if [[ "$SCOPE" != production ]]; then return 0; fi; systemctl --user reset-failed "${units[@]}" || true; systemctl --user start project-manager-api.service opportunity-manager-api.service; systemctl --user start project-manager-web.service opportunity-manager-web.service; frozen=0; }
wait_ready(){ [[ "$SCOPE" != production ]] && return 0; local attempt; for attempt in {1..30}; do local ok=1; for spec in 'http://127.0.0.1:3100/health 200' 'http://127.0.0.1:3211/health 200' 'http://127.0.0.1:3200 200' 'http://127.0.0.1:3210 200'; do read -r url expected_code <<<"$spec"; [[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)" == "$expected_code" ]] || ok=0; done; ((ok)) && return 0; sleep 1; done; echo 'ERROR: service readiness timeout' >&2; return 1; }
rollback(){ PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120s' "$PSQL" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$ROLLBACK"; }
append_audit(){ [[ -n "$audit" ]] && printf '%s\n' "$1" >> "$audit" || true; }
fail_handler(){ local code=$?; trap - EXIT; ((code==0)) && exit 0; append_audit "failure_at=$(date -Iseconds)"; append_audit 'final_status=failed'; if ((mutated)); then if [[ "$SCOPE" == production && "${ICT_G3_PUBLIC_EMPTY_ROLLBACK_CONFIRM:-}" != ICT-G3-PUBLIC-EMPTY-ROLLBACK-AUTHORIZED ]]; then append_audit 'rollback_status=not_authorized_services_frozen'; echo 'ROLLBACK_NOT_AUTHORIZED: services remain frozen' >&2; exit "$code"; fi; freeze || { append_audit 'rollback_status=freeze_failed'; exit "$code"; }; if rollback; then append_audit 'rollback_status=public_empty_rollback_pass'; start || true; else append_audit 'rollback_status=refused_or_failed_services_frozen'; echo 'PUBLIC_ROLLBACK_REFUSED: services remain frozen' >&2; fi; elif ((frozen)); then start || true; fi; exit "$code"; }
trap fail_handler EXIT
if [[ "$MODE" == --rollback-public-empty ]]; then
  if [[ "$SCOPE" == production ]]; then
    [[ "${ICT_G3_PUBLIC_EMPTY_ROLLBACK_CONFIRM:-}" == ICT-G3-PUBLIC-EMPTY-ROLLBACK-AUTHORIZED && "${ICT_G3_AUTHORIZED_SESSION:-}" =~ ^session-[0-9a-f-]+$ ]] || { echo 'ERROR: explicit public rollback authorization and session required' >&2; exit 1; }
    umask 077; audit="$ROOT/.tmp/ict-g3-differential-production-rollback-$(date +%Y%m%d-%H%M%S).audit"
    printf 'mode=rollback\nstarted_at=%s\nauthorized_session=%s\npublic_empty_rollback_sha256=%s\n' "$(date -Iseconds)" "$ICT_G3_AUTHORIZED_SESSION" "$(sha256sum "$ROLLBACK"|awk '{print $1}')" > "$audit"; chmod 600 "$audit"
  fi
  [[ "$(pre)" == "$post_expected" ]] || { append_audit 'rollback_status=permanently_refused_nonempty_or_drifted'; echo 'ERROR: public rollback permanently refused because migrated project state is not empty' >&2; exit 1; }
  freeze; rollback; start; wait_ready; append_audit 'rollback_status=pass'; append_audit "finished_at=$(date -Iseconds)"; trap - EXIT; echo 'DIFFERENTIAL_PUBLIC_ROLLBACK=PASS'; exit 0
fi
RESTORE_POINT="$(realpath -e "${ICT_G3_RESTORE_POINT:-}" 2>/dev/null || true)"
[[ "$RESTORE_POINT" == "$ROOT"/.tmp/ict-g3-differential-restore-point-* ]] || { echo 'ERROR: differential restore point required' >&2; exit 1; }
meta="$RESTORE_POINT/baseline.txt"; backup="$RESTORE_POINT/project-manager-pre-differential-g3.dump"
[[ -r "$meta" && -r "$backup" && ! -L "$meta" && ! -L "$backup" ]] || { echo 'ERROR: restore point files missing or unsafe' >&2; exit 1; }
grep -Fxq restore_point_status=verified "$meta"; grep -Fxq restore_point_kind=differential-g3 "$meta"; grep -Fxq "source_baseline=$expected" "$meta"
[[ "$(sha256sum "$backup"|awk '{print $1}')" == "$(sed -n 's/^backup_sha256=//p' "$meta")" ]] || { echo 'ERROR: restore checksum mismatch' >&2; exit 1; }
[[ "$(pre)" == "$expected" ]] || { echo 'ERROR: differential pre-state mismatch' >&2; exit 1; }
[[ -f "$MIGRATION" && -f "$OPPORTUNITY_REFERENCE" && -f "$ROLLBACK" ]] || { echo 'ERROR: migration references missing' >&2; exit 1; }
if [[ "$SCOPE" == production ]]; then
  created="$(date -d "$(sed -n 's/^created_at=//p' "$meta")" +%s 2>/dev/null || true)"; now="$(date +%s)"; [[ "$created" =~ ^[0-9]+$ && $((now-created)) -ge 0 && $((now-created)) -le 86400 ]] || { echo 'ERROR: restore point older than 24h' >&2; exit 1; }
  manifest="$(realpath -e "${ICT_G3_DEPLOYMENT_MANIFEST:-}" 2>/dev/null || true)"; [[ "$manifest" == "$ROOT"/.tmp/ict-g3-*/deployment-sha256.txt && -f "$manifest" && ! -L "$manifest" && "$(stat -c %u "$manifest")" == "$UID" && "$(stat -c %a "$manifest")" == 600 ]] || { echo 'ERROR: manifest missing or unsafe' >&2; exit 1; }
  (cd "$ROOT" && tail -n +3 "$manifest" | sha256sum -c - >/dev/null)
  grep -q 'database/migrations/0021_project_import_change_tracking.sql$' "$manifest" || { echo 'ERROR: 0021 absent from manifest' >&2; exit 1; }
  env_file=/home/lgsj/.config/llm-wiki-apps.env; [[ -f "$env_file" ]] || { echo 'ERROR: systemd environment file missing' >&2; exit 1; }
  runtime_flag="$(sed -n 's/^[[:space:]]*IMPORT_CHANGE_TRACKING_ENABLED[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -n1 | tr '[:upper:]' '[:lower:]' | xargs)"; [[ "$runtime_flag" =~ ^(true|1|on|enabled)$ ]] || { echo 'ERROR: systemd ICT gate not explicitly enabled' >&2; exit 1; }
  umask 077; audit="$ROOT/.tmp/ict-g3-differential-production-$(date +%Y%m%d-%H%M%S).audit"
  cat > "$audit" <<EOF
mode=apply
started_at=$(date -Iseconds)
authorized_session=$ICT_G3_AUTHORIZED_SESSION
restore_sha256=$(sha256sum "$backup"|awk '{print $1}')
manifest_sha256=$(sha256sum "$manifest"|awk '{print $1}')
project_0021_sha256=$(sha256sum "$MIGRATION"|awk '{print $1}')
opportunity_0005_reference_only_sha256=$(sha256sum "$OPPORTUNITY_REFERENCE"|awk '{print $1}')
public_empty_rollback_sha256=$(sha256sum "$ROLLBACK"|awk '{print $1}')
opportunity_0005_execution=forbidden_reference_only
runtime_gate_source=systemd_environment_file
runtime_gate_expected=enabled
sensitive_values_recorded=false
EOF
  chmod 600 "$audit"
fi
[[ "$MODE" == --preflight ]] && { trap - EXIT; echo 'DIFFERENTIAL_G3_PREFLIGHT=PASS'; exit 0; }
freeze
[[ "$(pre)" == "$expected" ]] || { echo 'ERROR: differential pre-state changed after freeze' >&2; exit 1; }
[[ "$(q "select 21-(select count(*) from drizzle.__drizzle_migrations)")" == 1 ]] || { echo 'ERROR: project 0021 is not the sole pending Drizzle migration' >&2; exit 1; }
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120s' DATABASE_URL="$DATABASE_URL" pnpm --dir "$ROOT" db:migrate
mutated=1
ICT_G3_SCOPE="$SCOPE" ICT_G3_PRODUCTION_CONFIRM="${ICT_G3_PRODUCTION_CONFIRM:-}" ICT_G3_AUTHORIZED_SESSION="${ICT_G3_AUTHORIZED_SESSION:-}" ICT_G3_EXECUTION_AUDIT_FILE="$audit" DATABASE_URL="$DATABASE_URL" ICT_PG_BIN_DIR="${ICT_PG_BIN_DIR:-}" "$ROOT/scripts/ict-g3-differential-post-verify.sh" --database-only
start
wait_ready
if [[ "$SCOPE" == production ]]; then
  ICT_G3_SCOPE=production ICT_G3_PRODUCTION_CONFIRM="$ICT_G3_PRODUCTION_CONFIRM" ICT_G3_AUTHORIZED_SESSION="$ICT_G3_AUTHORIZED_SESSION" ICT_G3_EXECUTION_AUDIT_FILE="$audit" DATABASE_URL="$DATABASE_URL" ICT_PG_BIN_DIR="${ICT_PG_BIN_DIR:-}" "$ROOT/scripts/ict-g3-differential-post-verify.sh" --all
fi
append_audit "finished_at=$(date -Iseconds)"; append_audit 'final_status=automated_pass_edge_pending'
trap - EXIT
echo 'DIFFERENTIAL_G3_APPLY=PASS'; echo 'RELEASE_STATE=READY_FOR_EDGE_G3_SMOKE'

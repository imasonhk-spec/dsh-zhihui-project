#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"; SCOPE="${ICT_G3_SCOPE:-isolated}"; DATABASE_URL="${DATABASE_URL:?DATABASE_URL required}"
PSQL="${ICT_PG_BIN_DIR:+$ICT_PG_BIN_DIR/}psql"; [[ "$PSQL" == */psql ]] || PSQL="$(command -v psql)"
[[ "$MODE" == --database-only || "$MODE" == --all ]] || { echo "usage: $0 {--database-only|--all}" >&2; exit 2; }
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
  expected_counts='14/1015/21/64/0'; expected_jobs=268; expected_project='0/0/0'; evidence_source='isolated-rehearsal'
else
  [[ "$name" == project_manager && "${ICT_G3_PRODUCTION_CONFIRM:-}" == ICT-G3-DIFFERENTIAL-POST-VERIFY-AUTHORIZED && "${ICT_G3_AUTHORIZED_SESSION:-}" =~ ^session-[0-9a-f-]+$ ]] || { echo 'ERROR: production post-verify authorization missing' >&2; exit 1; }
  watermark="$(realpath -e "${ICT_G3_AUTHORIZED_WATERMARK_FILE:-}" 2>/dev/null || true)"
  [[ "$watermark" == "$ROOT"/.tmp/ict-g3-authorized-final-watermark-*.txt && -f "$watermark" && ! -L "$watermark" && "$(stat -c %u "$watermark")" == "$UID" && "$(stat -c %a "$watermark")" == 600 ]] || { echo 'ERROR: authorized final watermark missing or unsafe' >&2; exit 1; }
  watermark_sha="$(sha256sum "$watermark"|awk '{print $1}')"; [[ "${ICT_G3_AUTHORIZED_WATERMARK_SHA256:-}" == "$watermark_sha" ]] || { echo 'ERROR: authorized final watermark checksum mismatch' >&2; exit 1; }
  grep -Fxq watermark_status=authorized_final_import_complete "$watermark"; grep -Fxq "authorized_session=$ICT_G3_AUTHORIZED_SESSION" "$watermark"; grep -Fxq user_confirmation=all_imports_completed "$watermark"; grep -Fxq project_public_empty_rollback=permanently_forbidden "$watermark"
  expected_counts="$(sed -n 's/^business_counts=//p' "$watermark")"; expected_jobs="$(sed -n 's/^import_jobs=//p' "$watermark")"; expected_project="$(sed -n 's/^project_ledgers=//p' "$watermark")"; evidence_source="$(basename "$watermark")"
fi
q(){ "$PSQL" "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$1"; }; fail(){ echo "VERIFY_FAIL: $1" >&2; echo 'DIFFERENTIAL_G3_POST_VERIFY=NO-GO' >&2; exit 1; }
counts="$(q "select (select count(*) from projects)||'/'||(select count(*) from tasks)||'/'||(select count(*) from knowledge_bases)||'/'||(select count(*) from opportunity.opportunities)||'/'||(select count(*) from opportunity.organizations)")"; journal="$(q 'select count(*) from drizzle.__drizzle_migrations')"; pt="$(q "select count(*) from information_schema.tables where table_schema='public' and table_name in('import_batches','import_batch_entities','import_field_changes')")"; ot="$(q "select count(*) from information_schema.tables where table_schema='opportunity' and table_name in('import_batches','import_batch_entities','import_field_changes','import_scope_currents','import_audit_events')")"; cols="$(q "select count(*) from information_schema.columns where table_schema='opportunity' and table_name='opportunities' and column_name in('customer_snapshot','is_current','archived_at','latest_import_batch_id')")"; pc="$(q "select count(*) from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace where n.nspname='public' and r.relname in('import_batches','import_batch_entities','import_field_changes')")"; oc="$(q "select count(*) from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace where n.nspname='opportunity' and r.relname in('import_batches','import_batch_entities','import_field_changes','import_scope_currents','import_audit_events')")"; jobs="$(q 'select count(*) from public.import_jobs')"; project="$(q "select (select count(*) from public.import_batches)||'/'||(select count(*) from public.import_batch_entities)||'/'||(select count(*) from public.import_field_changes)")"; opportunity="$(q "select (select count(*) from opportunity.import_batches)||'/'||(select count(*) from opportunity.import_batch_entities)||'/'||(select count(*) from opportunity.import_field_changes)||'/'||(select count(*) from opportunity.import_scope_currents)||'/'||(select count(*) from opportunity.import_audit_events)")"
printf 'BUSINESS_COUNTS=%s\nJOURNAL=%s\nPROJECT_ICT_TABLES=%s\nPROJECT_CONSTRAINTS=%s\nPROJECT_LEDGERS=%s\nOPPORTUNITY_LEDGERS=%s\nIMPORT_JOBS=%s\n' "$counts" "$journal" "$pt" "$pc" "$project" "$opportunity" "$jobs"
[[ "$counts" == "$expected_counts" ]] || fail counts; [[ "$journal" == 21 && "$pt" == 3 && "$ot" == 5 && "$cols" == 4 && "$pc" == 18 && "$oc" == 23 ]] || fail structure; [[ "$jobs" == "$expected_jobs" ]] || fail import_jobs; [[ "$project" == "$expected_project" ]] || fail project_ledgers; [[ "$opportunity" == 2/128/813/1/5 ]] || fail opportunity_ledgers
[[ "$MODE" == --database-only ]] && { echo 'DIFFERENTIAL_G3_POST_VERIFY=DATABASE_PASS'; exit 0; }
[[ "$SCOPE" == production ]] || fail production_scope
for spec in 'http://127.0.0.1:3100/health 200' 'http://127.0.0.1:3211/health 200' 'http://127.0.0.1:3200 200' 'http://127.0.0.1:3210 200' 'http://127.0.0.1:3100/api/projects 401' 'http://127.0.0.1:3211/api/opportunities 401'; do read -r url expected <<<"$spec"; code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"; [[ "$code" == "$expected" ]] || fail "http_${url}"; done
for unit in project-manager-api.service opportunity-manager-api.service project-manager-web.service opportunity-manager-web.service; do state="$(systemctl --user show "$unit" -p ActiveState -p SubState -p Result -p NRestarts --value | paste -sd /)"; [[ "$state" == active/running/success/0 ]] || fail "service_${unit}"; done
umask 077; evidence="$ROOT/.tmp/ict-g3-differential-post-verify-$(date +%Y%m%d-%H%M%S).txt"
cat > "$evidence" <<EOF
verification_status=automated_pass_edge_pending
verified_at=$(date -Iseconds)
authorized_session=$ICT_G3_AUTHORIZED_SESSION
evidence_source=$evidence_source
watermark_sha256=$watermark_sha
business_counts=$counts
journal=$journal
project_structure=$pt/$pc
project_ledgers=$project
opportunity_ledgers=$opportunity
import_jobs=$jobs
production_verification_read_only=true
project_public_empty_rollback=permanently_forbidden
service_state=active_running_success_nrestarts_0
sensitive_values_recorded=false
next_gate=windows_edge_145
EOF
chmod 600 "$evidence"; echo "EVIDENCE_FILE=$evidence"; echo 'DIFFERENTIAL_G3_POST_VERIFY=AUTOMATED_PASS_EDGE_PENDING'

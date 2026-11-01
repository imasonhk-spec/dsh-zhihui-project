#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
SCOPE="${ICT_G3_SCOPE:-isolated}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
PSQL="${ICT_PG_BIN_DIR:+$ICT_PG_BIN_DIR/}psql"
[[ "$PSQL" == */psql ]] || PSQL="$(command -v psql)"
EVIDENCE_DIR="${ICT_G3_EVIDENCE_DIR:-$ROOT/.tmp}"

usage() {
  echo "usage: ICT_G3_SCOPE=isolated|production DATABASE_URL=... $0 {--database-only|--all}" >&2
  exit 2
}
[[ "$MODE" == '--database-only' || "$MODE" == '--all' ]] || usage
[[ "$SCOPE" == isolated || "$SCOPE" == production ]] || usage
[[ -x "$PSQL" ]] || { echo 'ERROR: psql is unavailable' >&2; exit 1; }

read -r DB_HOST DB_NAME < <(python - "$DATABASE_URL" <<'PY'
from urllib.parse import urlsplit
import sys
u=urlsplit(sys.argv[1]);print(u.hostname or '',(u.path or '/').lstrip('/'))
PY
)
[[ "$DB_HOST" == 127.0.0.1 || "$DB_HOST" == localhost ]] || { echo 'ERROR: verification requires local PostgreSQL' >&2; exit 1; }
if [[ "$SCOPE" == isolated ]]; then
  [[ "$DB_NAME" =~ ^ict_g3_(exercise|release_test|post_verify)_[0-9]+_[0-9]+$ ]] || { echo 'ERROR: isolated database name is not allowed' >&2; exit 1; }
else
  [[ "$DB_NAME" == "${ICT_G3_PRODUCTION_DATABASE_NAME:-project_manager}" ]] || { echo 'ERROR: production database name mismatch' >&2; exit 1; }
  [[ "${ICT_G3_PRODUCTION_CONFIRM:-}" == 'ICT-G3-PRODUCTION-AUTHORIZED' ]] || { echo 'ERROR: production confirmation phrase missing' >&2; exit 1; }
  [[ "${ICT_G3_AUTHORIZED_SESSION:-}" =~ ^session-[0-9a-f-]+$ ]] || { echo 'ERROR: authorized session id missing' >&2; exit 1; }
  execution_audit="$(realpath -e "${ICT_G3_EXECUTION_AUDIT_FILE:-}" 2>/dev/null || true)"
  [[ "$execution_audit" == "$ROOT"/.tmp/ict-g3-production-*.audit && -f "$execution_audit" && ! -L "$execution_audit" ]] || { echo 'ERROR: managed G3 execution audit file missing' >&2; exit 1; }
  [[ "$(stat -c %u "$execution_audit")" == "$UID" && "$(stat -c %a "$execution_audit")" == 600 ]] || { echo 'ERROR: G3 execution audit metadata unsafe' >&2; exit 1; }
  grep -Fxq "authorized_session=$ICT_G3_AUTHORIZED_SESSION" "$execution_audit" || { echo 'ERROR: execution audit session mismatch' >&2; exit 1; }
  execution_audit_sha="$(sha256sum "$execution_audit" | awk '{print $1}')"
fi

fail() { echo "VERIFY_FAIL: $1" >&2; echo 'G3_POST_VERIFY=NO-GO' >&2; exit 1; }
query() { "$PSQL" "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$1"; }

journal="$(query 'select count(*) from drizzle.__drizzle_migrations')"
counts="$(query "select (select count(*) from projects)||'/'||(select count(*) from tasks)||'/'||(select count(*) from knowledge_bases)||'/'||(select count(*) from opportunity.opportunities)||'/'||(select count(*) from opportunity.organizations)")"
tables="$(query "select count(*) from information_schema.tables where (table_schema='public' and table_name in('import_batches','import_batch_entities','import_field_changes')) or (table_schema='opportunity' and table_name in('import_batches','import_batch_entities','import_field_changes','import_scope_currents','import_audit_events'))")"
columns="$(query "select count(*) from information_schema.columns where table_schema='opportunity' and table_name='opportunities' and column_name in('customer_snapshot','is_current','archived_at','latest_import_batch_id')")"
ledgers="$(query "select (select count(*) from public.import_batches)+(select count(*) from public.import_batch_entities)+(select count(*) from public.import_field_changes)+(select count(*) from opportunity.import_batches)+(select count(*) from opportunity.import_batch_entities)+(select count(*) from opportunity.import_field_changes)+(select count(*) from opportunity.import_scope_currents)+(select count(*) from opportunity.import_audit_events)")"
project_constraints="$(query "select count(*) from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace where n.nspname='public' and r.relname in('import_batches','import_batch_entities','import_field_changes')")"
opportunity_constraints="$(query "select count(*) from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace where n.nspname='opportunity' and r.relname in('import_batches','import_batch_entities','import_field_changes','import_scope_currents','import_audit_events')")"
printf 'JOURNAL=%s\nBUSINESS_COUNTS=%s\nICT_TABLES=%s\nOPPORTUNITY_COLUMNS=%s\nICT_LEDGER_ROWS=%s\nPROJECT_CONSTRAINTS=%s\nOPPORTUNITY_CONSTRAINTS=%s\n' "$journal" "$counts" "$tables" "$columns" "$ledgers" "$project_constraints" "$opportunity_constraints"
[[ "$journal" == 21 ]] || fail 'journal is not 21'
[[ "$counts" == '14/1015/21/0/0' ]] || fail 'business baseline changed'
[[ "$tables" == 8 && "$columns" == 4 ]] || fail 'ICT structure is incomplete'
[[ "$ledgers" == 0 ]] || fail 'ICT ledgers are not empty; probe prohibited'
[[ "$project_constraints" == 18 && "$opportunity_constraints" == 23 ]] || fail 'ICT constraint counts changed'

echo 'BEGINNING_ROLLBACK_ONLY_WRITE_PROBE=true'
"$PSQL" "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
INSERT INTO public.import_batches(app,scope_type,scope_id,kind,source_name,source_checksum,preview_fingerprint,status)
VALUES('project','project','00000000-0000-4000-8000-000000000000','tasks','g3-post-verify-probe','probe','probe','previewed');
INSERT INTO opportunity.import_batches(tenant_id,scope_id,source_name,source_checksum,preview_fingerprint,status)
VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','g3-post-verify-probe','probe','probe','previewed');
ROLLBACK;
SQL
post_probe="$(query "select (select count(*) from public.import_batches)+(select count(*) from opportunity.import_batches)")"
[[ "$post_probe" == 0 ]] || fail 'rollback-only write probe left rows'
echo 'ROLLBACK_ONLY_WRITE_PROBE=PASS'

if [[ "$MODE" == '--database-only' ]]; then
  echo 'G3_POST_VERIFY=DATABASE_PASS'
  exit 0
fi
[[ "$SCOPE" == production ]] || fail '--all is only allowed for production scope'

check_http() {
  local url="$1" expected="$2" code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
  echo "HTTP_${url##*:}=$code"
  [[ "$code" == "$expected" ]] || fail "unexpected HTTP status for $url"
}
check_http http://127.0.0.1:3100/health 200
check_http http://127.0.0.1:3211/health 200
check_http http://127.0.0.1:3200 200
check_http http://127.0.0.1:3210 200
check_http http://127.0.0.1:3100/api/projects 401
check_http http://127.0.0.1:3211/api/opportunities 401
for unit in project-manager-api.service opportunity-manager-api.service project-manager-web.service opportunity-manager-web.service; do
  active="$(systemctl --user show "$unit" -p ActiveState --value)"
  sub="$(systemctl --user show "$unit" -p SubState --value)"
  result="$(systemctl --user show "$unit" -p Result --value)"
  restarts="$(systemctl --user show "$unit" -p NRestarts --value)"
  echo "SERVICE=$unit/$active/$sub/$result/restarts=$restarts"
  [[ "$active" == active && "$sub" == running && "$result" == success && "$restarts" == 0 ]] || fail "service state invalid: $unit"
done

umask 077
mkdir -p "$EVIDENCE_DIR"
evidence="$EVIDENCE_DIR/ict-g3-post-verify-$(date +%Y%m%d-%H%M%S).txt"
cat > "$evidence" <<EOF
verification_status=automated_pass_edge_pending
verified_at=$(date -Iseconds)
authorized_session=${ICT_G3_AUTHORIZED_SESSION}
execution_audit_file=$(basename "$execution_audit")
execution_audit_preverify_sha256=$execution_audit_sha
journal=$journal
business_counts=$counts
ict_tables=$tables
opportunity_columns=$columns
ict_ledger_rows=$ledgers
project_constraints=$project_constraints
opportunity_constraints=$opportunity_constraints
rollback_only_write_probe=pass
health_and_unauthenticated_http=pass
service_state=active_running_success
sensitive_values_recorded=false
next_gate=windows_edge_145_authenticated_scope
EOF
chmod 600 "$evidence"
echo "EVIDENCE_FILE=$evidence"
echo 'G3_POST_VERIFY=AUTOMATED_PASS_EDGE_PENDING'

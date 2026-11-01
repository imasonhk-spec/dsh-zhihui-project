#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPP_ROOT="${OPPORTUNITY_ROOT:-$(cd "$ROOT/../bussiness-manager" && pwd)}"
STATE_DIR="${ICT_CANDIDATE_STATE_DIR:-$ROOT/.tmp/ict-candidate}"
STATE_FILE="$STATE_DIR/state.env"
LOG_DIR="$STATE_DIR/logs"
ENV_SOURCE="${ICT_ENV_FILE:-$HOME/.config/llm-wiki-apps.env}"
PROJECT_API_PORT="${ICT_PROJECT_API_PORT:-3221}"
PROJECT_WEB_PORT="${ICT_PROJECT_WEB_PORT:-3220}"
OPP_API_PORT="${ICT_OPPORTUNITY_API_PORT:-3231}"
OPP_WEB_PORT="${ICT_OPPORTUNITY_WEB_PORT:-3230}"
OPP_NO_TENANT_API_PORT="${ICT_OPPORTUNITY_NO_TENANT_API_PORT:-3232}"
TICKET_MINUTES="${ICT_CANDIDATE_TICKET_MINUTES:-30}"
[[ "$TICKET_MINUTES" =~ ^[0-9]+$ ]] && (( TICKET_MINUTES >= 1 && TICKET_MINUTES <= 60 )) || { echo 'ICT_CANDIDATE_TICKET_MINUTES must be 1..60' >&2; exit 1; }
HOST_IP="${ICT_CANDIDATE_HOST_IP:-$(ip -4 -brief address show scope global 2>/dev/null | awk '$1 !~ /^(podman|docker|tailscale)/ {split($3,a,"/"); print a[1]; exit}')}"
PUBLIC_HOST="${ICT_CANDIDATE_PUBLIC_HOST:-$HOST_IP}"

load_key() {
  local key="$1"
  python - "$ENV_SOURCE" "$key" <<'PY'
from pathlib import Path
import sys
p,key=Path(sys.argv[1]),sys.argv[2]
for raw in p.read_text().splitlines():
    line=raw.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k,v=line.split('=',1)
    if k.strip()==key:
        print(v.strip().strip('"').strip("'")); break
PY
}

quote_ident() { printf '"%s"' "${1//\"/\"\"}"; }

load_state() {
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" && -r "$STATE_FILE" ]] || { echo "candidate state is not a readable regular file: $STATE_FILE" >&2; return 1; }
  [[ "$(stat -c %u "$STATE_FILE")" == "$UID" && "$(stat -c %a "$STATE_FILE")" == 600 ]] || { echo 'candidate state owner or mode is unsafe' >&2; return 1; }
  local values=()
  mapfile -d '' -t values < <(python - "$STATE_FILE" "$UID" <<'PY'
import ast, os, re, stat, sys
from pathlib import Path
from urllib.parse import urlsplit
p=Path(sys.argv[1]); expected=[
 'DB_NAME','DATABASE_URL','ADMIN_URL','TENANT_ID','SERVICE_TOKEN','SUPERVISOR_PID',
 'SUPERVISOR_START_TICKS','SUPERVISOR_SCRIPT','HOST_IP','PUBLIC_HOST','PROJECT_API_PORT',
 'PROJECT_WEB_PORT','OPP_API_PORT','OPP_WEB_PORT','OPP_NO_TENANT_API_PORT']
st=p.stat()
if not stat.S_ISREG(st.st_mode) or st.st_uid != int(sys.argv[2]) or stat.S_IMODE(st.st_mode) != 0o600: raise SystemExit('unsafe_state_metadata')
data={}
for raw in p.read_text().splitlines():
    if not raw or '=' not in raw: raise SystemExit('invalid_state_line')
    key,value=raw.split('=',1)
    if key not in expected or key in data: raise SystemExit('invalid_state_key')
    try: parsed=ast.literal_eval(value)
    except Exception: raise SystemExit('invalid_state_value')
    if not isinstance(parsed,str) or '\x00' in parsed or '\n' in parsed: raise SystemExit('invalid_state_string')
    data[key]=parsed
if set(data) != set(expected): raise SystemExit('missing_state_key')
if not re.fullmatch(r'ict_edge_candidate_[0-9]+_[0-9]+',data['DB_NAME']): raise SystemExit('invalid_candidate_database')
if not data['SUPERVISOR_PID'].isdigit() or int(data['SUPERVISOR_PID']) < 1: raise SystemExit('invalid_supervisor_pid')
if not data['SUPERVISOR_START_TICKS'].isdigit(): raise SystemExit('invalid_supervisor_start')
if not os.path.isabs(data['SUPERVISOR_SCRIPT']): raise SystemExit('invalid_supervisor_script')
for key in ['PROJECT_API_PORT','PROJECT_WEB_PORT','OPP_API_PORT','OPP_WEB_PORT','OPP_NO_TENANT_API_PORT']:
    if not data[key].isdigit() or not 1 <= int(data[key]) <= 65535: raise SystemExit('invalid_port')
candidate,admin=urlsplit(data['DATABASE_URL']),urlsplit(data['ADMIN_URL'])
if candidate.hostname not in {'127.0.0.1','localhost'}: raise SystemExit('non_local_database')
if (candidate.scheme,candidate.netloc,candidate.query,candidate.fragment)!=(admin.scheme,admin.netloc,admin.query,admin.fragment): raise SystemExit('database_url_mismatch')
if candidate.path != '/'+data['DB_NAME'] or admin.path != '/postgres' or data['DATABASE_URL']==data['ADMIN_URL']: raise SystemExit('unsafe_database_urls')
for key in expected: sys.stdout.buffer.write(data[key].encode()+b'\0')
PY
  ) || { echo 'candidate state validation failed' >&2; return 1; }
  (( ${#values[@]} == 15 )) || { echo 'candidate state validation failed' >&2; return 1; }
  DB_NAME="${values[0]}"; DATABASE_URL="${values[1]}"; ADMIN_URL="${values[2]}"; TENANT_ID="${values[3]}"; SERVICE_TOKEN="${values[4]}"
  SUPERVISOR_PID="${values[5]}"; SUPERVISOR_START_TICKS="${values[6]}"; SUPERVISOR_SCRIPT="${values[7]}"; HOST_IP="${values[8]}"; PUBLIC_HOST="${values[9]}"
  PROJECT_API_PORT="${values[10]}"; PROJECT_WEB_PORT="${values[11]}"; OPP_API_PORT="${values[12]}"; OPP_WEB_PORT="${values[13]}"; OPP_NO_TENANT_API_PORT="${values[14]}"
}
require_state() { load_state || exit 1; }

supervisor_identity_matches() {
  [[ -r "/proc/$SUPERVISOR_PID/stat" && -r "/proc/$SUPERVISOR_PID/cmdline" ]] || return 1
  python - "$SUPERVISOR_PID" "$SUPERVISOR_START_TICKS" "$SUPERVISOR_SCRIPT" <<'PY'
import os, sys
pid,expected_ticks,expected_script=sys.argv[1:]
try:
    fields=open(f'/proc/{pid}/stat').read().split()
    args=open(f'/proc/{pid}/cmdline','rb').read().split(b'\0')
    cwd=os.readlink(f'/proc/{pid}/cwd')
except OSError:
    raise SystemExit(1)
if len(fields) < 22 or fields[21] != expected_ticks or b'run' not in args: raise SystemExit(1)
resolved=[]
for raw in args:
    if not raw: continue
    value=os.fsdecode(raw)
    candidate=value if os.path.isabs(value) else os.path.join(cwd,value)
    try: resolved.append(os.path.realpath(candidate))
    except OSError: pass
raise SystemExit(0 if os.path.realpath(expected_script) in resolved else 1)
PY
}

recover_stale() {
  [[ -r "$STATE_FILE" ]] || return 0
  load_state || return 1
  if supervisor_identity_matches; then
    echo "candidate supervisor is still running: $SUPERVISOR_PID" >&2
    return 2
  fi
  if kill -0 "$SUPERVISOR_PID" 2>/dev/null; then echo "candidate supervisor PID was reused; no signal sent: $SUPERVISOR_PID" >&2; fi
  psql "$ADMIN_URL" -X -v ON_ERROR_STOP=1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB_NAME' and pid<>pg_backend_pid()" >/dev/null || return 1
  psql "$ADMIN_URL" -X -v ON_ERROR_STOP=1 -c "drop database if exists $(quote_ident "$DB_NAME")" >/dev/null || return 1
  rm -f "$STATE_FILE"
  echo "recovered stale ICT candidate database: $DB_NAME"
}

status() {
  require_state
  printf 'database=%s\nproject_web=http://%s:%s\nopportunity_web=http://%s:%s\n' "$DB_NAME" "$HOST_IP" "$PROJECT_WEB_PORT" "$HOST_IP" "$OPP_WEB_PORT"
  for entry in project-api:$PROJECT_API_PORT project-web:$PROJECT_WEB_PORT opportunity-api:$OPP_API_PORT opportunity-web:$OPP_WEB_PORT; do
    name="${entry%%:*}"; port="${entry##*:}"
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/${name#*-}" >/dev/null 2>&1 || ss -ltn 2>/dev/null | grep -q ":$port "; then
      echo "$name=running"
    else
      echo "$name=not-ready"
    fi
  done
}

issue_ticket() {
  require_state
  local ticket
  ticket="$(psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "insert into auth_tickets(app,redirect_url,expires_at) values('project','http://$PUBLIC_HOST:$PROJECT_WEB_PORT',now()+interval '$TICKET_MINUTES minutes') returning ticket" | head -n 1)"
  printf 'Candidate login URL (one-time, expires in %s minutes):\n' "$TICKET_MINUTES"
  printf 'http://%s:%s/__ict-login/%s\n' "$PUBLIC_HOST" "$PROJECT_WEB_PORT" "$ticket"
  printf 'After login, open opportunity: http://%s:%s\n' "$PUBLIC_HOST" "$OPP_WEB_PORT"
}

stop_env() {
  require_state
  supervisor_identity_matches || { echo 'refusing stop: supervisor identity mismatch; use recover for stale state' >&2; return 1; }
  kill -TERM "$SUPERVISOR_PID"
  echo "stop requested for verified supervisor $SUPERVISOR_PID"
}

run_env() {
  if [[ -r "$STATE_FILE" ]]; then recover_stale || exit $?; fi
  [[ -r "$ENV_SOURCE" ]] || { echo "environment source unreadable: $ENV_SOURCE" >&2; exit 1; }
  [[ -n "$HOST_IP" ]] || { echo 'candidate IPv4 address unavailable' >&2; exit 1; }
  for port in "$PROJECT_API_PORT" "$PROJECT_WEB_PORT" "$OPP_API_PORT" "$OPP_WEB_PORT" "$OPP_NO_TENANT_API_PORT"; do
    if ss -ltn 2>/dev/null | grep -q ":$port "; then echo "candidate port already in use: $port" >&2; exit 1; fi
  done
  local source_url admin_url db_name database_url tenant_id service_token s3_bucket bootstrap_ticket
  source_url="${DATABASE_URL:-$(load_key DATABASE_URL)}"
  [[ -n "$source_url" ]] || { echo 'DATABASE_URL missing from process environment and environment source' >&2; exit 1; }
  read -r admin_url db_name database_url < <(python - "$source_url" <<'PY'
from urllib.parse import urlsplit,urlunsplit
import os,sys,time
u=urlsplit(sys.argv[1])
if u.hostname not in {'127.0.0.1','localhost'}: raise SystemExit('candidate_db_guard_non_local')
name=f'ict_edge_candidate_{os.getpid()}_{int(time.time())}'
admin=urlunsplit((u.scheme,u.netloc,'/postgres',u.query,u.fragment))
db=urlunsplit((u.scheme,u.netloc,'/'+name,u.query,u.fragment))
print(admin,name,db)
PY
  )
  tenant_id="$(python - <<'PY'
import uuid
print(uuid.uuid4())
PY
  )"
  service_token="$(python - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
  )"
  s3_bucket="ict-edge-candidate-${db_name##*_}"
  mkdir -p "$LOG_DIR"
  chmod 700 "$STATE_DIR" "$LOG_DIR"
  (cd "$ROOT" && pnpm exec tsx scripts/create-ict-edge-fixtures.ts .tmp/ict-edge-fixtures) >"$LOG_DIR/fixtures.log" 2>&1
  install -m 0600 "$ROOT/scripts/ict-candidate-console.html" "$ROOT/.tmp/ict-edge-fixtures/ict-candidate-console.html"

  local children=() cleaned=0
  cleanup() {
    local code=$? cleanup_failed=0; trap - EXIT INT TERM
    for pid in "${children[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
    for pid in "${children[@]}"; do wait "$pid" 2>/dev/null || true; done
    if (( cleaned == 0 )); then
      psql "$admin_url" -X -v ON_ERROR_STOP=1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$db_name' and pid<>pg_backend_pid()" >/dev/null 2>&1 || cleanup_failed=1
      if (( cleanup_failed == 0 )); then
        psql "$admin_url" -X -v ON_ERROR_STOP=1 -c "drop database if exists $(quote_ident "$db_name")" >/dev/null 2>&1 || cleanup_failed=1
      fi
      (( cleanup_failed == 0 )) && cleaned=1
    fi
    if (( cleaned == 1 )); then
      rm -f "$STATE_FILE"
      echo "ICT candidate environment stopped and database dropped: $db_name"
    else
      echo "candidate database cleanup failed; state retained for recover: $STATE_FILE" >&2
      (( code == 0 )) && code=1
    fi
    exit "$code"
  }
  trap cleanup EXIT INT TERM

  psql "$admin_url" -X -v ON_ERROR_STOP=1 -c "create database $(quote_ident "$db_name")" >/dev/null
  (cd "$ROOT" && DATABASE_URL="$database_url" pnpm db:migrate) >"$LOG_DIR/project-migrate.log" 2>&1
  for sql in "$OPP_ROOT"/database/000{1,2,3,4,5}_*.sql; do
    psql "$database_url" -X -v ON_ERROR_STOP=1 -f "$sql" >>"$LOG_DIR/opportunity-migrate.log" 2>&1
  done
  psql "$database_url" -X -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into auth_users(username,password_hash,display_name)
values('admin','candidate-login-disabled','ICT Edge验收员')
on conflict(username) do update set display_name=excluded.display_name;
insert into projects(code,name,status,description)
values('ICT-EDGE-001','ICT-1 Edge 145验收项目','planning','隔离候选环境专用，销毁候选库时自动删除')
on conflict(code) do nothing;
SQL
  bootstrap_ticket="$(psql "$database_url" -X -qAt -v ON_ERROR_STOP=1 -c "insert into auth_tickets(app,redirect_url,expires_at) values('project','http://$PUBLIC_HOST:$PROJECT_WEB_PORT',now()+interval '$TICKET_MINUTES minutes') returning ticket" | head -n 1)"

  local supervisor_start_ticks supervisor_script state_tmp
  supervisor_start_ticks="$(awk '{print $22}' "/proc/$$/stat")"
  supervisor_script="$(realpath -e "$0")"
  state_tmp="$STATE_FILE.tmp.$$"
  umask 077
  cat >"$state_tmp" <<EOF
DB_NAME='$db_name'
DATABASE_URL='$database_url'
ADMIN_URL='$admin_url'
TENANT_ID='$tenant_id'
SERVICE_TOKEN='$service_token'
SUPERVISOR_PID='$$'
SUPERVISOR_START_TICKS='$supervisor_start_ticks'
SUPERVISOR_SCRIPT='$supervisor_script'
HOST_IP='$HOST_IP'
PUBLIC_HOST='$PUBLIC_HOST'
PROJECT_API_PORT='$PROJECT_API_PORT'
PROJECT_WEB_PORT='$PROJECT_WEB_PORT'
OPP_API_PORT='$OPP_API_PORT'
OPP_WEB_PORT='$OPP_WEB_PORT'
OPP_NO_TENANT_API_PORT='$OPP_NO_TENANT_API_PORT'
EOF
  chmod 600 "$state_tmp"
  mv -f "$state_tmp" "$STATE_FILE"

  common_env=(DATABASE_URL="$database_url" ZH_SERVICE_TOKEN="$service_token" OPPORTUNITY_TENANT_ID="$tenant_id" ZH_SESSION_COOKIE_NAME=zh_candidate_session NODE_ENV=development)
  (cd "$ROOT" && env "${common_env[@]}" PORT="$PROJECT_API_PORT" HOST=0.0.0.0 WEB_ALLOWED_ORIGINS="http://$HOST_IP:$PROJECT_WEB_PORT" S3_ENDPOINT="http://127.0.0.1:1" S3_BUCKET="$s3_bucket" PERSONAL_KNOWLEDGE_ACCOUNT_IDS="" PERSONAL_REPORT_INTERVAL_MS=86400000 pnpm exec tsx apps/api/src/server.ts) >"$LOG_DIR/project-api.log" 2>&1 & children+=("$!")
  (cd "$OPP_ROOT" && env "${common_env[@]}" OPPORTUNITY_PORT="$OPP_API_PORT" PROJECT_API_BASE_URL="http://127.0.0.1:$PROJECT_API_PORT" pnpm exec tsx apps/api/src/server.ts) >"$LOG_DIR/opportunity-api.log" 2>&1 & children+=("$!")
  (cd "$OPP_ROOT" && env DATABASE_URL="$database_url" ZH_SERVICE_TOKEN="$service_token" ZH_SESSION_COOKIE_NAME=zh_candidate_session NODE_ENV=development OPPORTUNITY_PORT="$OPP_NO_TENANT_API_PORT" OPPORTUNITY_HOST=127.0.0.1 PROJECT_API_BASE_URL="http://127.0.0.1:$PROJECT_API_PORT" pnpm exec tsx apps/api/src/server.ts) >"$LOG_DIR/opportunity-no-tenant-api.log" 2>&1 & children+=("$!")
  (cd "$ROOT" && PROJECT_WEB_PORT="$PROJECT_WEB_PORT" PROJECT_API_PROXY_TARGET="http://127.0.0.1:$PROJECT_API_PORT" OPPORTUNITY_API_PROXY_TARGET="http://127.0.0.1:$OPP_API_PORT" OPPORTUNITY_NO_TENANT_API_PROXY_TARGET="http://127.0.0.1:$OPP_NO_TENANT_API_PORT" ICT_CANDIDATE_FIXTURE_DIR="$ROOT/.tmp/ict-edge-fixtures" ICT_CANDIDATE_SERVER_TICKET=true ICT_CANDIDATE_BOOTSTRAP_TICKET="$bootstrap_ticket" pnpm exec vite --config apps/web/vite.config.ts --strictPort) >"$LOG_DIR/project-web.log" 2>&1 & children+=("$!")
  (cd "$OPP_ROOT" && OPPORTUNITY_WEB_PORT="$OPP_WEB_PORT" PROJECT_API_PROXY_TARGET="http://127.0.0.1:$PROJECT_API_PORT" OPPORTUNITY_API_PROXY_TARGET="http://127.0.0.1:$OPP_API_PORT" pnpm exec vite --config apps/web/vite.config.ts --strictPort) >"$LOG_DIR/opportunity-web.log" 2>&1 & children+=("$!")

  for spec in "$PROJECT_API_PORT:/health" "$PROJECT_WEB_PORT:/" "$OPP_API_PORT:/health" "$OPP_NO_TENANT_API_PORT:/health" "$OPP_WEB_PORT:/"; do
    port="${spec%%:*}"; path="${spec#*:}"
    ready=0
    for _ in $(seq 1 60); do
      if curl -fsS --max-time 2 "http://127.0.0.1:$port$path" >/dev/null 2>&1; then ready=1; break; fi
      sleep 0.5
    done
    (( ready == 1 )) || { echo "candidate service failed on port $port; see $LOG_DIR" >&2; exit 1; }
  done

  echo 'ICT candidate environment ready (isolated database; no production data copied).'
  status
  issue_ticket
  echo "Logs: $LOG_DIR"
  echo 'Keep this process running during Edge validation; stop with the stop command or interrupt it.'
  while true; do
    for pid in "${children[@]}"; do kill -0 "$pid" 2>/dev/null || { echo "candidate child exited: $pid" >&2; exit 1; }; done
    sleep 5
  done
}

case "${1:-}" in
  run) run_env ;;
  status) status ;;
  ticket) issue_ticket ;;
  stop) stop_env ;;
  recover) recover_stale ;;
  *) echo "usage: $0 {run|status|ticket|stop|recover}" >&2; exit 2 ;;
esac

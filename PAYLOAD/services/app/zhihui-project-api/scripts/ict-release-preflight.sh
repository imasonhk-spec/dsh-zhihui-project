#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPPORTUNITY_ROOT="${OPPORTUNITY_ROOT:-$(cd "$ROOT/../bussiness-manager" && pwd)}"
ENV_FILE="${ICT_ENV_FILE:-$HOME/.config/llm-wiki-apps.env}"
RUN_VERIFY=0

if [[ "${1:-}" == "--verify" ]]; then
  RUN_VERIFY=1
elif [[ -n "${1:-}" ]]; then
  echo "usage: $0 [--verify]" >&2
  exit 2
fi

pass=0
warn=0
fail=0
report() {
  local level="$1" message="$2"
  printf '[%s] %s\n' "$level" "$message"
  case "$level" in
    PASS) pass=$((pass + 1)) ;;
    WARN) warn=$((warn + 1)) ;;
    FAIL) fail=$((fail + 1)) ;;
  esac
}

check_file() {
  local path="$1" label="$2"
  if [[ -f "$path" ]]; then report PASS "$label"; else report FAIL "$label missing: $path"; fi
}

echo 'ICT-1 release preflight (read-only; never migrates, restarts, or deploys)'
check_file "$ROOT/database/migrations/0021_project_import_change_tracking.sql" 'project migration 0021 exists'
check_file "$OPPORTUNITY_ROOT/database/0005_opportunity_import_change_tracking.sql" 'opportunity migration 0005 exists'
check_file "$ROOT/scripts/ict-g3-backup-verify.sh" 'G3 backup/restore verification script exists'

if [[ -n "${DATABASE_URL:-}" ]]; then
  if "$ROOT/scripts/ict-g3-backup-verify.sh" --check >/dev/null 2>&1; then
    report PASS 'PostgreSQL backup/restore client major matches the server'
  else
    report FAIL 'PostgreSQL backup/restore client major does not match the server; set ICT_PG_BIN_DIR to the matching client bin directory'
  fi
else
  report FAIL 'DATABASE_URL is missing; backup/restore compatibility cannot be checked'
fi

if grep -q '0021_project_import_change_tracking' "$ROOT/database/migrations/meta/_journal.json"; then
  report PASS 'Drizzle journal contains project migration 0021'
else
  report FAIL 'Drizzle journal does not contain project migration 0021'
fi

if [[ ! -r "$ENV_FILE" ]]; then
  report FAIL 'service environment file is not readable'
else
  tenant_state="$(python - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys

value = ''
for raw in Path(sys.argv[1]).read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, candidate = line.split('=', 1)
    if key.strip() == 'OPPORTUNITY_TENANT_ID':
        value = candidate.strip().strip('"').strip("'")
        break
print(value)
PY
  )"
  feature_state="$(python - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys
value = ''
for raw in Path(sys.argv[1]).read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, candidate = line.split('=', 1)
    if key.strip() == 'IMPORT_CHANGE_TRACKING_ENABLED':
        value = candidate.strip().strip('"').strip("'")
        break
print(value)
PY
  )"
  if [[ -z "$tenant_state" ]]; then
    report FAIL 'OPPORTUNITY_TENANT_ID is missing (value intentionally not printed)'
  elif [[ "$tenant_state" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    report PASS 'OPPORTUNITY_TENANT_ID is present and UUID-shaped (value hidden)'
  else
    report FAIL 'OPPORTUNITY_TENANT_ID is present but not a valid UUID (value hidden)'
  fi
  case "${feature_state,,}" in
    true|1|on|enabled) report PASS 'IMPORT_CHANGE_TRACKING_ENABLED is explicitly enabled (value normalized, raw value hidden)' ;;
    '') report FAIL 'IMPORT_CHANGE_TRACKING_ENABLED is not explicitly configured for release' ;;
    *) report FAIL 'IMPORT_CHANGE_TRACKING_ENABLED is not in an enabled release state (raw value hidden)' ;;
  esac
fi

browser=''
for candidate in microsoft-edge microsoft-edge-stable chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then browser="$candidate"; break; fi
done
if [[ -n "$browser" ]]; then
  version="$($browser --version 2>/dev/null || true)"
  if [[ "$version" == *'145.'* ]]; then
    report PASS "browser 145 found: ${version%%$'\n'*}"
  else
    report WARN "browser found but target version 145 not confirmed: ${version%%$'\n'*}"
  fi
else
  report FAIL 'Edge/Chromium executable not found; G1 real-browser gate remains open'
fi

if (cd "$ROOT" && pnpm exec playwright --version >/dev/null 2>&1); then
  report PASS 'Playwright command is available'
else
  report WARN 'Playwright command unavailable; use the Windows Edge manual evidence template'
fi

if (( RUN_VERIFY == 1 )); then
  echo 'Running non-production build and test verification...'
  (cd "$ROOT" && pnpm typecheck:api && pnpm build:api && pnpm test) \
    && report PASS 'project API exact verification passed' \
    || report FAIL 'project API exact verification failed'
  (cd "$OPPORTUNITY_ROOT" && pnpm typecheck:api && pnpm build:api && pnpm test) \
    && report PASS 'opportunity API exact verification passed' \
    || report FAIL 'opportunity API exact verification failed'
else
  report WARN 'exact builds/tests not run; pass --verify to execute non-production verification'
fi

printf 'SUMMARY pass=%d warn=%d fail=%d\n' "$pass" "$warn" "$fail"
if (( fail > 0 )); then
  echo 'RELEASE_GATE=NO-GO'
  exit 1
fi
echo 'RELEASE_GATE=READY_FOR_MANUAL_GATES'

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail(){ echo "G3_TOOL_TEST_FAIL: $1" >&2; exit 1; }
pass(){ echo "ok - $1"; }

bash -n scripts/ict-g3-differential-backup-verify.sh scripts/ict-g3-differential-release.sh scripts/ict-g3-differential-post-verify.sh || fail shell_syntax
pass shell_syntax
for file in scripts/ict-g3-differential-backup-verify.sh scripts/ict-g3-differential-release.sh scripts/ict-g3-differential-post-verify.sh; do
  [[ "$(stat -c %a "$file")" == 700 ]] || fail "mode_$file"
done
pass owner_only_script_modes

rollback=database/rollback/0021_public_empty_only.sql
grep -Fq 'ict_project_empty_rollback_refused' "$rollback" || fail rollback_empty_guard
grep -Fq 'created_at = 1789202600000' "$rollback" || fail rollback_exact_journal
grep -Fq 'ict_project_empty_rollback_journal_invalid' "$rollback" || fail rollback_journal_assertion
grep -Fq 'public.import_jobs' "$rollback" || fail rollback_import_jobs_guard
if grep -Ei '(DROP|ALTER|DELETE|TRUNCATE)[[:space:]].*opportunity|opportunity.*(DROP|ALTER|DELETE|TRUNCATE)' "$rollback" >/dev/null; then fail rollback_opportunity_write; fi
pass rollback_public_only_contract

grep -Fq 'production migration is already complete' scripts/ict-g3-differential-release.sh || fail production_apply_retirement
grep -Fq 'ICT-G3-PUBLIC-EMPTY-ROLLBACK-AUTHORIZED' scripts/ict-g3-differential-release.sh || fail rollback_authorization
grep -Fq 'mode=rollback' scripts/ict-g3-differential-release.sh || fail rollback_audit
grep -Fq 'opportunity_0005_execution=forbidden_reference_only' scripts/ict-g3-differential-release.sh || fail opportunity_reference_only
grep -Fq 'wait_ready' scripts/ict-g3-differential-release.sh || fail readiness_wait
if grep -E 'psql.*0005|0005.*[[:space:]]-f' scripts/ict-g3-differential-release.sh >/dev/null; then fail opportunity_migration_execution; fi
pass release_fail_closed_contract

grep -Fq 'ICT-G3-DIFFERENTIAL-POST-VERIFY-AUTHORIZED' scripts/ict-g3-differential-post-verify.sh || fail postverify_authorization
grep -Fq 'ICT_G3_AUTHORIZED_WATERMARK_SHA256' scripts/ict-g3-differential-post-verify.sh || fail watermark_checksum_binding
grep -Fq 'authorized_session=' scripts/ict-g3-differential-post-verify.sh || fail session_binding
grep -Fq 'production_verification_read_only=true' scripts/ict-g3-differential-post-verify.sh || fail readonly_evidence
grep -Fq 'project_public_empty_rollback=permanently_forbidden' scripts/ict-g3-differential-post-verify.sh || fail rollback_forbidden_evidence
pass postverify_evidence_contract

grep -Fq 'PG_DUMP_MAJOR' scripts/ict-g3-differential-backup-verify.sh || fail pg_major_gate
grep -Fq 'source_database=$DB_NAME' scripts/ict-g3-differential-backup-verify.sh || fail source_database_binding
grep -Fq 'restore_point_status=verified' scripts/ict-g3-differential-backup-verify.sh || fail restore_verification
grep -Fq 'chmod 600' scripts/ict-g3-differential-backup-verify.sh || fail backup_modes
pass backup_restore_contract

echo 'ICT_G3_DIFFERENTIAL_TOOL_TESTS=PASS'

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const manifestPath = 'artifacts/kb-modernization/eval/kb-eval-20260917-0.1.0/manifest.jsonl'
const manifest = await readFile(manifestPath, 'utf8')
const rows = manifest.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
const required = ['caseId', 'scenario', 'workspace', 'authorizedProjectIds', 'query', 'expectedEvidenceIds', 'forbiddenSourceIds', 'expectedDecision', 'seed']
assert.ok(rows.length >= 12)
assert.equal(new Set(rows.map(row => row.caseId)).size, rows.length)
for (const row of rows) {
  for (const field of required) assert.ok(field in row, `${String(row.caseId)} missing ${field}`)
  assert.equal(row.seed, 20260917)
  assert.match(String(row.workspace), /^(project:|portfolio:OPP-MASTER)/)
}
for (const scenario of ['ordinary-project-cross-project-request', 'portfolio-forged-authorized-set', 'personal-account-domain-isolation', 'null-project-domain-isolation', 'user-prompt-injection', 'document-instruction-injection', 'legacy-shadow-dual-read-comparison', 'feature-flag-rollback']) {
  assert.ok(rows.some(row => row.scenario === scenario), `missing scenario ${scenario}`)
}
const hash = createHash('sha256').update(manifest).digest('hex')
console.log(JSON.stringify({ ok: true, datasetVersion: 'kb-eval-20260917-0.1.0', cases: rows.length, seed: 20260917, manifestSha256: hash }))

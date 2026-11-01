import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const migrationPath = new URL('../../../../../database/migrations/0022_evidence_envelope_citations.sql', import.meta.url)
const migrationDirectory = new URL('../../../../../database/migrations/', import.meta.url)
const metaDirectory = new URL('../../../../../database/migrations/meta/', import.meta.url)

test('0022 is additive, backfills old citations and contains no destructive statement', async () => {
  const sql = await readFile(migrationPath, 'utf8')
  assert.match(sql, /ALTER TABLE "ai_citations" ADD COLUMN/)
  assert.match(sql, /UPDATE "ai_citations" c[\s\S]*"source_project_id" = coalesce\(c\."source_project_id", d\."project_id"\)/)
  assert.match(sql, /"checksum" = coalesce\(c\."checksum",[\s\S]*d\."checksum"\)/)
  assert.match(sql, /"captured_at" = coalesce\(c\."captured_at", c\."created_at"\)/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS/)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/)
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE)\b/i)
  assert.doesNotMatch(sql, /document_chunks[\s\S]*embedding/i)
})

test('migration inventory contains the reviewed hand-written 0022 and no generated duplicate', async () => {
  const sqlFiles = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort()
  assert.equal(sqlFiles.at(-1), '0022_evidence_envelope_citations.sql')
  assert.equal(sqlFiles.filter(name => name.startsWith('0021_')).length, 1)
  assert.equal(sqlFiles.includes('0021_project_import_change_tracking.sql'), true)
  const metaFiles = (await readdir(metaDirectory)).filter(name => name.endsWith('_snapshot.json')).sort()
  assert.equal(metaFiles.at(-1), '0008_snapshot.json')
})

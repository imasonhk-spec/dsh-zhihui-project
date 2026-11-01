import assert from 'node:assert/strict'
import test from 'node:test'
import { executeKnowledgeRead, resolveKnowledgeReadPolicy, rollbackKnowledgeReadPolicy } from './knowledge-read-rollout.ts'

test('read policy is fail-closed to legacy and never enables production rollout', () => {
  assert.deepEqual(resolveKnowledgeReadPolicy(undefined), { mode: 'legacy', candidateReadOnly: true, productionRolloutPercent: 0 })
  assert.equal(resolveKnowledgeReadPolicy('candidate').mode, 'legacy')
  assert.equal(resolveKnowledgeReadPolicy('shadow').mode, 'shadow')
})

test('shadow dual-read serves legacy while recording deterministic differences', async () => {
  const result = await executeKnowledgeRead({
    policy: resolveKnowledgeReadPolicy('shadow'),
    legacy: async () => [{ id: 'a' }, { id: 'b' }],
    candidate: async () => [{ id: 'b' }, { id: 'c' }],
    ids: rows => rows.map(row => row.id),
  })
  assert.equal(result.servedBy, 'legacy')
  assert.deepEqual(result.value, [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual(result.shadow, { legacyCount: 2, candidateCount: 2, overlapCount: 1, legacyOnlyIds: ['a'], candidateOnlyIds: ['c'] })
})

test('candidate failure cannot fail or replace the legacy response', async () => {
  const result = await executeKnowledgeRead({
    policy: resolveKnowledgeReadPolicy('shadow'),
    legacy: async () => [{ id: 'legacy' }],
    candidate: async () => { throw new Error('shadow_unavailable') },
    ids: rows => rows.map(row => row.id),
  })
  assert.equal(result.servedBy, 'legacy')
  assert.deepEqual(result.value, [{ id: 'legacy' }])
  assert.equal(result.shadow?.candidateError, 'shadow_unavailable')
})

test('rollback is immediate, data-preserving and requires no vector rebuild', () => {
  assert.deepEqual(rollbackKnowledgeReadPolicy(), { mode: 'legacy', candidateReadOnly: true, productionRolloutPercent: 0 })
})

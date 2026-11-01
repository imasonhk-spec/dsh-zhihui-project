import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizedProjectKnowledgePredicate, validateAuthorizedProjectIds } from './hybrid-search-scope.ts'

const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'

test('authorized project ids reject empty and forged values', () => {
  assert.throws(() => validateAuthorizedProjectIds([]), /knowledge_authorized_projects_invalid/)
  assert.throws(() => validateAuthorizedProjectIds([A, "x') or true --"]), /knowledge_authorized_projects_invalid/)
})

test('authorized project ids cannot be expanded except by the server input', () => {
  assert.deepEqual(validateAuthorizedProjectIds([A, B, A]), [A, B])
})

test('candidate predicate contains every personal and null-domain exclusion', () => {
  const query = authorizedProjectKnowledgePredicate([A, B]) as unknown as { queryChunks: Array<{ value?: unknown }> }
  const text = query.queryChunks.flatMap(chunk => Array.isArray(chunk.value) ? chunk.value : typeof chunk.value === 'string' ? [chunk.value] : []).join(' ').replace(/\s+/g, ' ')
  assert.match(text, /d\.project_id is not null/)
  assert.match(text, /d\.project_id in/)
  assert.match(text, /kb\.scope = 'project'/)
  assert.match(text, /kb\.account_id is null/)
  assert.match(text, /kb\.project_id = d\.project_id/)
})

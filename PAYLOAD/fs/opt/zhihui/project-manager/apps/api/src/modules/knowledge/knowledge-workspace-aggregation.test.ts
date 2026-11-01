import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAggregatedFolderTree } from './knowledge-service.ts'

const PARENT = '01-项目管理过程'
const PLAN = `${PARENT}/01-项目实施计划`
const folderSources = [
  { id: 'a-parent', path: PARENT, projectId: 'p-a', projectCode: 'PRJ-A', projectName: '甲项目' },
  { id: 'a-plan', path: PLAN, projectId: 'p-a', projectCode: 'PRJ-A', projectName: '甲项目' },
  { id: 'b-parent', path: PARENT, projectId: 'p-b', projectCode: 'PRJ-B', projectName: '乙项目' },
  { id: 'b-plan', path: PLAN, projectId: 'p-b', projectCode: 'PRJ-B', projectName: '乙项目' },
]

test('aggregated folder count equals its source project breakdown', () => {
  const documents = [
    ...Array.from({ length: 31 }, (_, index) => ({ projectId: 'p-a', folderId: 'a-plan', status: index === 0 ? 'archived' : 'confirmed' })),
    ...Array.from({ length: 24 }, () => ({ projectId: 'p-b', folderId: 'b-plan', status: 'confirmed' })),
  ]
  const roots = buildAggregatedFolderTree(folderSources, documents, 'kb-master')
  const plan = roots[0]?.children[0]

  assert.equal(plan?.path, PLAN)
  assert.equal(plan?.documentCount, 54)
  assert.deepEqual(plan?.sourceBreakdown, [
    { code: 'PRJ-A', name: '甲项目', count: 30 },
    { code: 'PRJ-B', name: '乙项目', count: 24 },
  ])
  assert.equal(plan?.documentCount, plan?.sourceBreakdown?.reduce((sum, source) => sum + source.count, 0))
})

test('source breakdown is still present as an empty array for aggregate folders without documents', () => {
  const roots = buildAggregatedFolderTree(folderSources, [], 'kb-master')
  assert.deepEqual(roots[0]?.sourceBreakdown, [])
  assert.deepEqual(roots[0]?.children[0]?.sourceBreakdown, [])
})

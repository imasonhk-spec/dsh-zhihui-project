import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../apps/api/src/db/client.ts'
import { documentChunks, documents, documentVersions, knowledgeBases, knowledgeFolders, projects } from '../apps/api/src/db/schema.ts'
import { searchProjectKnowledgeContent } from '../apps/api/src/modules/knowledge/full-text-search-service.ts'

const projectA = randomUUID(), projectB = randomUUID(), baseA = randomUUID(), baseB = randomUUID(), folderA = randomUUID()
const documentA = randomUUID(), archivedA = randomUUID(), obsoleteA = randomUUID(), documentB = randomUUID()
const versionA = randomUUID(), archivedVersion = randomUUID(), obsoleteVersion = randomUUID(), versionB = randomUUID()
try {
  await db.insert(projects).values([{ id: projectA, code: `SEARCH-${projectA.slice(0, 8)}`, name: '搜索验收A' }, { id: projectB, code: `SEARCH-${projectB.slice(0, 8)}`, name: '搜索验收B' }])
  await db.insert(knowledgeBases).values([{ id: baseA, projectId: projectA, name: '检索库A' }, { id: baseB, projectId: projectB, name: '检索库B' }])
  await db.insert(knowledgeFolders).values({ id: folderA, knowledgeBaseId: baseA, name: '交付资料', path: '交付资料' })
  await db.insert(documents).values([
    { id: documentA, projectId: projectA, knowledgeBaseId: baseA, folderId: folderA, name: '项目上线方案', originalName: 'launch.md', fileType: 'md', status: 'confirmed', parseStatus: 'completed', aiEnabled: false },
    { id: archivedA, projectId: projectA, knowledgeBaseId: baseA, name: '归档上线方案', originalName: 'archived.md', fileType: 'md', status: 'archived', parseStatus: 'completed', aiEnabled: false },
    { id: obsoleteA, projectId: projectA, knowledgeBaseId: baseA, name: '废止上线方案', originalName: 'obsolete.md', fileType: 'md', status: 'obsolete', parseStatus: 'completed', aiEnabled: false },
    { id: documentB, projectId: projectB, knowledgeBaseId: baseB, name: '其他项目方案', originalName: 'other.md', fileType: 'md', status: 'confirmed', parseStatus: 'completed', aiEnabled: false },
  ])
  await db.insert(documentVersions).values([
    { id: versionA, documentId: documentA, versionNumber: 'v1', storageKey: `smoke/${versionA}`, isCurrent: true },
    { id: archivedVersion, documentId: archivedA, versionNumber: 'v1', storageKey: `smoke/${archivedVersion}`, isCurrent: true },
    { id: obsoleteVersion, documentId: obsoleteA, versionNumber: 'v1', storageKey: `smoke/${obsoleteVersion}`, isCurrent: true },
    { id: versionB, documentId: documentB, versionNumber: 'v1', storageKey: `smoke/${versionB}`, isCurrent: true },
  ])
  await db.insert(documentChunks).values([
    { documentId: documentA, versionId: versionA, chunkIndex: 0, content: '蓝鲸计划上线窗口定于周五，回滚步骤必须经过负责人确认。', pageNumber: 3, sectionPath: '部署 / 回滚' },
    { documentId: archivedA, versionId: archivedVersion, chunkIndex: 0, content: '蓝鲸计划归档版本记录。' },
    { documentId: obsoleteA, versionId: obsoleteVersion, chunkIndex: 0, content: '蓝鲸计划废止版本记录。' },
    { documentId: documentB, versionId: versionB, chunkIndex: 0, content: '蓝鲸计划属于其他项目，严禁跨项目泄露。' },
  ])

  const result = await searchProjectKnowledgeContent(projectA, { q: '蓝鲸 回滚' })
  assert.equal(result.total, 1); assert.equal(result.items[0]?.documentId, documentA); assert.equal(result.items[0]?.pageNumber, 3); assert.equal(result.items[0]?.sectionPath, '部署 / 回滚')
  assert.match(result.items[0]?.snippet ?? '', /蓝鲸计划/); assert.match(result.items[0]?.snippet ?? '', /回滚步骤/)
  const archived = await searchProjectKnowledgeContent(projectA, { q: '蓝鲸', includeArchived: 'true' })
  assert.equal(archived.total, 2); assert.ok(archived.items.some(item => item.documentId === archivedA)); assert.ok(!archived.items.some(item => item.documentId === obsoleteA || item.documentId === documentB))
  const filtered = await searchProjectKnowledgeContent(projectA, { q: '蓝鲸', folderId: folderA, fileType: 'md', status: 'confirmed' })
  assert.equal(filtered.total, 1); assert.equal(filtered.items[0]?.folderPath, '交付资料')
  let invalidRejected = false
  try { await searchProjectKnowledgeContent(projectA, { q: ' ' }) } catch (error) { invalidRejected = error instanceof Error && error.message === 'knowledge_search_query_invalid' }
  assert.equal(invalidRejected, true)
  console.log(JSON.stringify({ ok: true, chineseTerms: result.terms, projectIsolation: true, archivedOptIn: true, obsoleteExcluded: true, traceableLocation: true }))
} finally {
  await db.delete(projects).where(eq(projects.id, projectA)).catch(() => undefined)
  await db.delete(projects).where(eq(projects.id, projectB)).catch(() => undefined)
  await pool.end()
}

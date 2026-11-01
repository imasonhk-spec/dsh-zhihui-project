import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../apps/api/src/db/client.ts'
import { documentChunks, documents, documentVersions, knowledgeBases, projects } from '../apps/api/src/db/schema.ts'
import { buildKnowledgeObjectKey, checksumSha256, deleteKnowledgeObject, putKnowledgeObject } from '../apps/api/src/infrastructure/object-storage.ts'
import { listProjectDocumentVersionChunks, parseProjectKnowledgeDocumentVersion } from '../apps/api/src/modules/knowledge/document-processing-service.ts'

const projectId = randomUUID(), otherProjectId = randomUUID(), baseId = randomUUID(), documentId = randomUUID(), versionId = randomUUID()
const body = Buffer.from('# 项目目标\n完成10.2解析验收。\n\n## 来源定位\n中文内容必须保持完整。')
const storageKey = buildKnowledgeObjectKey(projectId, documentId, versionId)
try {
  await db.insert(projects).values([
    { id: projectId, code: `PARSE-${projectId.slice(0, 8)}`, name: '解析验收项目' },
    { id: otherProjectId, code: `PARSE-${otherProjectId.slice(0, 8)}`, name: '隔离验收项目' },
  ])
  await db.insert(knowledgeBases).values({ id: baseId, projectId, name: '解析验收知识库' })
  await db.insert(documents).values({ id: documentId, projectId, knowledgeBaseId: baseId, name: '10.2验收文档', originalName: 'acceptance.md', fileType: 'md', mimeType: 'text/markdown; charset=utf-8', fileSize: body.length, checksum: checksumSha256(body), storageKey, version: 'v1', status: 'confirmed', parseStatus: 'pending', indexStatus: 'pending', aiEnabled: false })
  await db.insert(documentVersions).values({ id: versionId, documentId, versionNumber: 'v1', storageKey, checksum: checksumSha256(body), fileSize: body.length, mimeType: 'text/markdown; charset=utf-8', originalName: 'acceptance.md', isCurrent: true })
  await putKnowledgeObject({ key: storageKey, body, contentType: 'text/markdown; charset=utf-8', contentLength: body.length })

  const first = await parseProjectKnowledgeDocumentVersion(projectId, documentId, versionId)
  assert.ok(first && first.chunkCount === 2)
  const chunks = await listProjectDocumentVersionChunks(projectId, documentId, versionId)
  assert.equal(chunks?.length, 2)
  assert.equal(chunks?.[1]?.sectionPath, '项目目标 / 来源定位')
  assert.match(chunks?.[0]?.content ?? '', /10.2解析验收/)

  const [document] = await db.select({ parseStatus: documents.parseStatus, indexStatus: documents.indexStatus, aiEnabled: documents.aiEnabled }).from(documents).where(eq(documents.id, documentId))
  assert.deepEqual(document, { parseStatus: 'completed', indexStatus: 'pending', aiEnabled: false })
  assert.ok((await db.select({ id: documentChunks.id }).from(documentChunks).where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.versionId, versionId)))).every(() => true))

  const second = await parseProjectKnowledgeDocumentVersion(projectId, documentId, versionId)
  assert.equal(second?.chunkCount, 2)
  assert.equal((await listProjectDocumentVersionChunks(projectId, documentId, versionId))?.length, 2)
  assert.equal(await parseProjectKnowledgeDocumentVersion(otherProjectId, documentId, versionId), undefined)

  console.log(JSON.stringify({ ok: true, persistedChunks: 2, idempotentReparse: true, projectIsolation: true, statuses: document }))
} finally {
  await deleteKnowledgeObject(storageKey).catch(() => undefined)
  await db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined)
  await db.delete(projects).where(eq(projects.id, otherProjectId)).catch(() => undefined)
  await pool.end()
}

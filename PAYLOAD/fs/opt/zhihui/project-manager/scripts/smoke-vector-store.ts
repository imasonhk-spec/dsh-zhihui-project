import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../apps/api/src/db/client.ts'
import { documentChunks, documents, documentVersions, knowledgeBases, projects } from '../apps/api/src/db/schema.ts'
import { KNOWLEDGE_EMBEDDING_DIMENSIONS, replaceProjectDocumentVersionChunks, searchProjectKnowledgeVectors } from '../apps/api/src/modules/knowledge/vector-store-service.ts'

const projectA = randomUUID()
const projectB = randomUUID()
const baseA = randomUUID()
const baseB = randomUUID()
const documentA = randomUUID()
const documentB = randomUUID()
const versionA = randomUUID()
const versionB = randomUUID()
const embeddingA = Array.from({ length: KNOWLEDGE_EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0)
const embeddingB = Array.from({ length: KNOWLEDGE_EMBEDDING_DIMENSIONS }, (_, index) => index === 1 ? 1 : 0)

try {
  await db.insert(projects).values([
    { id: projectA, code: `VECTOR-A-${projectA.slice(0, 8)}`, name: '向量检索验收项目A' },
    { id: projectB, code: `VECTOR-B-${projectB.slice(0, 8)}`, name: '向量检索验收项目B' },
  ])
  await db.insert(knowledgeBases).values([
    { id: baseA, projectId: projectA, name: '向量验收知识库A' },
    { id: baseB, projectId: projectB, name: '向量验收知识库B' },
  ])
  await db.insert(documents).values([
    { id: documentA, projectId: projectA, knowledgeBaseId: baseA, name: 'A文档', originalName: 'a.md', fileType: 'md', version: 'v1', status: 'confirmed', aiEnabled: false },
    { id: documentB, projectId: projectB, knowledgeBaseId: baseB, name: 'B文档', originalName: 'b.md', fileType: 'md', version: 'v1', status: 'confirmed', aiEnabled: false },
  ])
  await db.insert(documentVersions).values([
    { id: versionA, documentId: documentA, versionNumber: 'v1', storageKey: `smoke/${versionA}`, isCurrent: true },
    { id: versionB, documentId: documentB, versionNumber: 'v1', storageKey: `smoke/${versionB}`, isCurrent: true },
  ])

  const indexedA = await replaceProjectDocumentVersionChunks(projectA, documentA, versionA, [{ chunkIndex: 0, content: '项目A的唯一知识分块', embedding: embeddingA }])
  const indexedB = await replaceProjectDocumentVersionChunks(projectB, documentB, versionB, [{ chunkIndex: 0, content: '项目B的唯一知识分块', embedding: embeddingB }])
  if (!indexedA || !indexedB) throw new Error('vector_smoke_index_failed')

  const projectAResults = await searchProjectKnowledgeVectors(projectA, { embedding: embeddingA, limit: 5, minScore: 0 })
  if (projectAResults.length !== 1 || projectAResults[0]?.documentId !== documentA) throw new Error('vector_smoke_project_isolation_failed')
  if (projectAResults.some(result => result.documentId === documentB)) throw new Error('vector_smoke_cross_project_leak')

  await replaceProjectDocumentVersionChunks(projectA, documentA, versionA, [{ chunkIndex: 0, content: '项目A覆盖后的唯一知识分块', embedding: embeddingA }])
  const chunksAfterReplace = await db.select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentId, documentA))
  if (chunksAfterReplace.length !== 1) throw new Error('vector_smoke_idempotent_replace_failed')

  let invalidEmbeddingRejected = false
  try { await searchProjectKnowledgeVectors(projectA, { embedding: embeddingA.slice(1) }) }
  catch (error) { invalidEmbeddingRejected = error instanceof Error && error.message === 'knowledge_vector_search_embedding_invalid' }
  if (!invalidEmbeddingRejected) throw new Error('vector_smoke_validation_failed')

  console.log(JSON.stringify({ ok: true, indexedChunks: indexedA.chunkCount + indexedB.chunkCount, projectIsolation: true, vectorDimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS }))
} finally {
  await db.delete(projects).where(eq(projects.id, projectA)).catch(() => undefined)
  await db.delete(projects).where(eq(projects.id, projectB)).catch(() => undefined)
  await pool.end()
}

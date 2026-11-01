import { and, asc, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, documentChunks, documents, documentVersions } from '../../db/schema.ts'
import { EMBEDDING_MODEL, EMBEDDING_PROVIDER, embedTexts, embeddingContentHash } from '../../infrastructure/embedding-client.ts'
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from './vector-store-service.ts'

export async function embedProjectDocumentVersion(projectId: string, documentId: string, versionId: string) {
  assertUuid(projectId, 'project_id_invalid'); assertUuid(documentId, 'knowledge_document_id_invalid'); assertUuid(versionId, 'knowledge_version_id_invalid')
  const [version] = await db.select({ id: documentVersions.id, versionNumber: documentVersions.versionNumber, isCurrent: documentVersions.isCurrent, status: documents.status, parseStatus: documents.parseStatus, metadata: documents.metadata }).from(documentVersions).innerJoin(documents, eq(documents.id, documentVersions.documentId)).where(and(eq(documentVersions.id, versionId), eq(documents.id, documentId), eq(documents.projectId, projectId))).limit(1)
  if (!version) return undefined
  if (!version.isCurrent) throw new Error('knowledge_version_not_current')
  if (version.status === 'archived' || version.status === 'obsolete') throw new Error('knowledge_document_not_indexable')
  if (version.parseStatus !== 'completed') throw new Error('knowledge_document_not_parsed')
  const chunks = await db.select({ id: documentChunks.id, content: documentChunks.content, metadata: documentChunks.metadata }).from(documentChunks).where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.versionId, versionId))).orderBy(asc(documentChunks.chunkIndex))
  if (!chunks.length) throw new Error('knowledge_chunks_required')
  const pending = chunks.filter(chunk => {
    const metadata = chunk.metadata.embedding as Record<string, unknown> | undefined
    return metadata?.provider !== EMBEDDING_PROVIDER || metadata?.model !== EMBEDDING_MODEL || metadata?.dimensions !== KNOWLEDGE_EMBEDDING_DIMENSIONS || metadata?.contentHash !== embeddingContentHash(chunk.content)
  })
  await db.update(documents).set({ indexStatus: 'processing', aiEnabled: false, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
  try {
    const vectors: number[][] = []
    for (let offset = 0; offset < pending.length; offset += 64) {
      vectors.push(...await embedTexts(pending.slice(offset, offset + 64).map(chunk => chunk.content)))
    }
    const generatedAt = new Date().toISOString()
    await db.transaction(async tx => {
      for (let index = 0; index < pending.length; index++) {
        const chunk = pending[index]!, embedding = vectors[index]!
        await tx.update(documentChunks).set({ embedding, metadata: { ...chunk.metadata, embedding: { provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL, dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS, generatedAt, contentHash: embeddingContentHash(chunk.content) } }, updatedAt: new Date() }).where(and(eq(documentChunks.id, chunk.id), eq(documentChunks.versionId, versionId)))
      }
      await tx.update(documents).set({ indexStatus: 'completed', aiEnabled: true, metadata: { ...version.metadata, embeddingSummary: { provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL, dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS, chunks: chunks.length, generated: pending.length, reused: chunks.length - pending.length, completedAt: generatedAt } }, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
      await tx.insert(auditLogs).values({ projectId, entityType: 'document', entityId: documentId, action: 'embedded', actorName: 'system', changes: { version: version.versionNumber, provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL, dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS, chunkCount: chunks.length, generated: pending.length, reused: chunks.length - pending.length, summary: `完成文档 ${version.versionNumber} 向量化（生成 ${pending.length}，复用 ${chunks.length - pending.length}）` } })
    })
    return { documentId, versionId, versionNumber: version.versionNumber, provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL, dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS, chunkCount: chunks.length, generated: pending.length, reused: chunks.length - pending.length }
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith('knowledge_') ? error.message : 'knowledge_embedding_failed'
    await db.update(documents).set({ indexStatus: 'failed', aiEnabled: false, metadata: { ...version.metadata, embeddingError: { code, versionId, failedAt: new Date().toISOString() } }, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId))).catch(() => undefined)
    throw new Error(code)
  }
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function assertUuid(value: string, code: string) { if (!UUID_PATTERN.test(value)) throw new Error(code) }

import { and, asc, cosineDistance, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, documentChunks, documents, documentVersions } from '../../db/schema.ts'

export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1024
export const MAX_VECTOR_CHUNKS_PER_WRITE = 200
export const MAX_VECTOR_SEARCH_RESULTS = 50

export type VectorChunkInput = {
  chunkIndex: number
  title?: string | null
  content: string
  pageNumber?: number | null
  sectionPath?: string | null
  tokenCount?: number | null
  embedding: number[]
  metadata?: Record<string, unknown>
}

export type VectorSearchInput = {
  embedding: number[]
  limit?: number
  minScore?: number
}

export async function replaceProjectDocumentVersionChunks(projectId: string, documentId: string, versionId: string, input: unknown) {
  assertUuid(projectId, 'project_id_invalid')
  assertUuid(documentId, 'knowledge_document_id_invalid')
  assertUuid(versionId, 'knowledge_version_id_invalid')
  const chunks = validateChunks(input)
  const [version] = await db.select({
    id: documentVersions.id,
    versionNumber: documentVersions.versionNumber,
    isCurrent: documentVersions.isCurrent,
    documentId: documents.id,
    projectId: documents.projectId,
    status: documents.status,
  }).from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(and(eq(documentVersions.id, versionId), eq(documents.id, documentId), eq(documents.projectId, projectId)))
    .limit(1)
  if (!version) return undefined
  if (!version.isCurrent) throw new Error('knowledge_version_not_current')
  if (version.status === 'archived' || version.status === 'obsolete') throw new Error('knowledge_document_not_indexable')

  return db.transaction(async tx => {
    await tx.delete(documentChunks).where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.versionId, versionId)))
    const inserted = await tx.insert(documentChunks).values(chunks.map(chunk => ({
      documentId,
      versionId,
      chunkIndex: chunk.chunkIndex,
      title: chunk.title,
      content: chunk.content,
      pageNumber: chunk.pageNumber,
      sectionPath: chunk.sectionPath,
      tokenCount: chunk.tokenCount,
      embedding: chunk.embedding,
      metadata: chunk.metadata,
    }))).returning({ id: documentChunks.id, chunkIndex: documentChunks.chunkIndex })
    await tx.update(documents).set({ parseStatus: 'completed', indexStatus: 'completed', aiEnabled: true, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
    await tx.insert(auditLogs).values({
      projectId,
      entityType: 'document',
      entityId: documentId,
      action: 'indexed',
      actorName: 'system',
      changes: { version: version.versionNumber, chunkCount: inserted.length, summary: `完成文档 ${version.versionNumber} 向量索引（${inserted.length} 个分块）` },
    })
    return { documentId, versionId, versionNumber: version.versionNumber, chunkCount: inserted.length }
  })
}

export async function searchProjectKnowledgeVectors(projectId: string, input: unknown) {
  assertUuid(projectId, 'project_id_invalid')
  const query = validateSearch(input)
  const distance = cosineDistance(documentChunks.embedding, query.embedding)
  const maxDistance = 1 - query.minScore
  const rows = await db.select({
    chunkId: documentChunks.id,
    documentId: documents.id,
    documentName: documents.name,
    versionId: documentVersions.id,
    versionNumber: documentVersions.versionNumber,
    chunkIndex: documentChunks.chunkIndex,
    title: documentChunks.title,
    content: documentChunks.content,
    pageNumber: documentChunks.pageNumber,
    sectionPath: documentChunks.sectionPath,
    metadata: documentChunks.metadata,
    score: sql<number>`1 - (${distance})`,
  }).from(documentChunks)
    .innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .innerJoin(documentVersions, and(eq(documentVersions.id, documentChunks.versionId), eq(documentVersions.documentId, documents.id)))
    .where(and(
      eq(documents.projectId, projectId),
      eq(documents.aiEnabled, true),
      eq(documents.indexStatus, 'completed'),
      eq(documentVersions.isCurrent, true),
      inArray(documents.status, ['draft', 'reviewing', 'confirmed']),
      sql`${documentChunks.embedding} is not null`,
      sql`${distance} <= ${maxDistance}`,
    ))
    .orderBy(asc(distance), asc(documentChunks.id))
    .limit(query.limit)
  return rows.map(row => ({ ...row, score: Number(row.score) }))
}

function validateChunks(input: unknown): VectorChunkInput[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('knowledge_chunks_required')
  if (input.length > MAX_VECTOR_CHUNKS_PER_WRITE) throw new Error('knowledge_chunks_limit_exceeded')
  const indexes = new Set<number>()
  return input.map((raw, position) => {
    if (!isRecord(raw)) throw new Error('knowledge_chunk_invalid')
    const allowed = new Set(['chunkIndex', 'title', 'content', 'pageNumber', 'sectionPath', 'tokenCount', 'embedding', 'metadata'])
    for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error('knowledge_chunk_field_invalid')
    const chunkIndex = raw.chunkIndex
    if (!Number.isSafeInteger(chunkIndex) || (chunkIndex as number) < 0 || indexes.has(chunkIndex as number)) throw new Error('knowledge_chunk_index_invalid')
    indexes.add(chunkIndex as number)
    const content = normalizeRequiredText(raw.content, 20_000, 'knowledge_chunk_content_invalid')
    const title = normalizeOptionalText(raw.title, 500, 'knowledge_chunk_title_invalid')
    const sectionPath = normalizeOptionalText(raw.sectionPath, 1_000, 'knowledge_chunk_section_invalid')
    const pageNumber = optionalPositiveInteger(raw.pageNumber, 'knowledge_chunk_page_invalid')
    const tokenCount = optionalNonNegativeInteger(raw.tokenCount, 'knowledge_chunk_token_count_invalid')
    const metadata = raw.metadata === undefined ? {} : isRecord(raw.metadata) ? raw.metadata : (() => { throw new Error('knowledge_chunk_metadata_invalid') })()
    return { chunkIndex: chunkIndex as number, title, content, pageNumber, sectionPath, tokenCount, embedding: validateEmbedding(raw.embedding, `knowledge_chunk_embedding_invalid:${position}`), metadata }
  })
}

function validateSearch(input: unknown) {
  if (!isRecord(input)) throw new Error('knowledge_vector_search_body_invalid')
  for (const key of Object.keys(input)) if (!['embedding', 'limit', 'minScore'].includes(key)) throw new Error('knowledge_vector_search_field_invalid')
  const limit = input.limit === undefined ? 10 : input.limit
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_VECTOR_SEARCH_RESULTS) throw new Error('knowledge_vector_search_limit_invalid')
  const minScore = input.minScore === undefined ? 0.65 : input.minScore
  if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < -1 || minScore > 1) throw new Error('knowledge_vector_search_score_invalid')
  return { embedding: validateEmbedding(input.embedding, 'knowledge_vector_search_embedding_invalid'), limit: limit as number, minScore }
}

function validateEmbedding(value: unknown, code: string) {
  if (!Array.isArray(value) || value.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) throw new Error(code.split(':')[0])
  if (value.every(item => item === 0)) throw new Error(code.split(':')[0])
  return value as number[]
}

function normalizeRequiredText(value: unknown, max: number, code: string) {
  if (typeof value !== 'string') throw new Error(code)
  const text = value.trim()
  if (!text || text.length > max || /\u0000/.test(text)) throw new Error(code)
  return text
}
function normalizeOptionalText(value: unknown, max: number, code: string) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new Error(code)
  const text = value.trim()
  if (!text || text.length > max || /\u0000/.test(text)) throw new Error(code)
  return text
}
function optionalPositiveInteger(value: unknown, code: string) {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(code)
  return value as number
}
function optionalNonNegativeInteger(value: unknown, code: string) {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code)
  return value as number
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function assertUuid(value: string, code: string) { if (!UUID_PATTERN.test(value)) throw new Error(code) }

import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, documentChunks, documents, documentVersions } from '../../db/schema.ts'
import { checksumSha256, getKnowledgeObject } from '../../infrastructure/object-storage.ts'
import { chunkParsedDocument, parseKnowledgeDocument, SUPPORTED_PARSE_TYPES } from './document-parser.ts'

const MAX_PARSE_OBJECT_BYTES = Number(process.env.KNOWLEDGE_PARSE_MAX_BYTES ?? 20 * 1024 * 1024)

export async function parseProjectKnowledgeDocumentVersion(projectId: string, documentId: string, versionId: string) {
  assertUuid(projectId, 'project_id_invalid'); assertUuid(documentId, 'knowledge_document_id_invalid'); assertUuid(versionId, 'knowledge_version_id_invalid')
  const version = await getScopedVersion(projectId, documentId, versionId)
  if (!version) return undefined
  if (!version.isCurrent) throw new Error('knowledge_version_not_current')
  if (version.status === 'archived' || version.status === 'obsolete') throw new Error('knowledge_document_not_indexable')
  if (!SUPPORTED_PARSE_TYPES.has(version.fileType)) throw new Error('knowledge_parse_type_unsupported')
  if (!version.storageKey) throw new Error('knowledge_document_file_missing')

  await db.update(documents).set({ parseStatus: 'processing', indexStatus: 'pending', aiEnabled: false, metadata: clearParseError(version.metadata), updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
  try {
    const object = await getKnowledgeObject(version.storageKey)
    const body = await bodyToBuffer(object.body, MAX_PARSE_OBJECT_BYTES)
    if (version.fileSize !== null && body.length !== version.fileSize) throw new Error('knowledge_parse_file_size_mismatch')
    const checksum = checksumSha256(body)
    if (version.checksum && checksum !== version.checksum) throw new Error('knowledge_parse_checksum_mismatch')
    const parsed = await parseKnowledgeDocument({ body, fileType: version.fileType, originalName: version.originalName || version.name })
    const chunks = chunkParsedDocument(parsed, { originalName: version.originalName || version.name, checksum: version.checksum, documentId, versionId })

    return await db.transaction(async tx => {
      const locked = await tx.execute<{ id: string }>(sql`select dv.id from document_versions dv join documents d on d.id = dv.document_id where dv.id = ${versionId} and dv.document_id = ${documentId} and d.project_id = ${projectId} and dv.is_current = true for update`)
      if (!locked.rows[0]) throw new Error('knowledge_version_not_current')
      await tx.delete(documentChunks).where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.versionId, versionId)))
      for (let offset = 0; offset < chunks.length; offset += 200) {
        await tx.insert(documentChunks).values(chunks.slice(offset, offset + 200).map(chunk => ({ documentId, versionId, chunkIndex: chunk.chunkIndex, title: chunk.title, content: chunk.content, pageNumber: chunk.pageNumber, sectionPath: chunk.sectionPath, tokenCount: null, embedding: null, metadata: chunk.metadata })))
      }
      const ocrChunks = chunks.filter(chunk => chunk.metadata.extractionMethod === 'ocr')
      const confidences = ocrChunks.map(chunk => chunk.metadata.ocrConfidence).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      await tx.update(documents).set({ parseStatus: 'completed', indexStatus: 'pending', aiEnabled: false, metadata: { ...clearParseError(version.metadata), parseSummary: { versionId, parser: parsed.parser, chunks: chunks.length, warnings: parsed.warnings.length, ocrPages: new Set(ocrChunks.map(chunk => chunk.pageNumber)).size, meanOcrConfidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null, needsReview: ocrChunks.some(chunk => chunk.metadata.needsReview === true), completedAt: new Date().toISOString() } }, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
      await tx.insert(auditLogs).values({ projectId, entityType: 'document', entityId: documentId, action: 'parsed', actorName: 'system', changes: { version: version.versionNumber, parser: parsed.parser, chunkCount: chunks.length, warnings: parsed.warnings.length, summary: `完成文档解析 ${version.name}（${version.versionNumber}，${chunks.length} 个分块）` } })
      return { documentId, versionId, versionNumber: version.versionNumber, parser: parsed.parser, chunkCount: chunks.length, warningCount: parsed.warnings.length }
    })
  } catch (error) {
    const code = publicParseError(error)
    const latest = await getScopedVersion(projectId, documentId, versionId).catch(() => undefined)
    if (latest?.isCurrent) await db.update(documents).set({ parseStatus: 'failed', indexStatus: 'pending', aiEnabled: false, metadata: { ...latest.metadata, parseError: { code, versionId, failedAt: new Date().toISOString() } }, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId))).catch(() => undefined)
    throw new Error(code)
  }
}

export async function listProjectDocumentVersionChunks(projectId: string, documentId: string, versionId: string) {
  const version = await getScopedVersion(projectId, documentId, versionId)
  if (!version) return undefined
  return db.select({ id: documentChunks.id, chunkIndex: documentChunks.chunkIndex, title: documentChunks.title, content: documentChunks.content, pageNumber: documentChunks.pageNumber, sectionPath: documentChunks.sectionPath, tokenCount: documentChunks.tokenCount, metadata: documentChunks.metadata, createdAt: documentChunks.createdAt }).from(documentChunks).where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.versionId, versionId))).orderBy(documentChunks.chunkIndex)
}

async function getScopedVersion(projectId: string, documentId: string, versionId: string) {
  const [row] = await db.select({ id: documentVersions.id, versionNumber: documentVersions.versionNumber, storageKey: documentVersions.storageKey, checksum: documentVersions.checksum, fileSize: documentVersions.fileSize, originalName: documentVersions.originalName, isCurrent: documentVersions.isCurrent, documentId: documents.id, name: documents.name, projectId: documents.projectId, fileType: documents.fileType, status: documents.status, metadata: documents.metadata }).from(documentVersions).innerJoin(documents, eq(documents.id, documentVersions.documentId)).where(and(eq(documentVersions.id, versionId), eq(documents.id, documentId), eq(documents.projectId, projectId))).limit(1)
  return row
}
async function bodyToBuffer(body: unknown, maxBytes: number) {
  if (!body) throw new Error('knowledge_document_file_missing')
  if (typeof body === 'object' && 'transformToByteArray' in body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray(); if (bytes.length > maxBytes) throw new Error('knowledge_parse_file_size_invalid'); return Buffer.from(bytes)
  }
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of body as AsyncIterable<Uint8Array>) { const value = Buffer.from(chunk); size += value.length; if (size > maxBytes) throw new Error('knowledge_parse_file_size_invalid'); chunks.push(value) }
  return Buffer.concat(chunks)
}
function clearParseError(metadata: Record<string, unknown>) { const result = { ...metadata }; delete result.parseError; return result }
function publicParseError(error: unknown) { const raw = error instanceof Error ? error.message : 'knowledge_parse_failed'; return raw.startsWith('knowledge_') ? raw : 'knowledge_parse_failed' }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function assertUuid(value: string, code: string) { if (!UUID_PATTERN.test(value)) throw new Error(code) }

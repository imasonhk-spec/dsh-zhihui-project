import { and, asc, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, documentChunks, documents, documentVersions, projects } from '../../db/schema.ts'
import { resolveLlmWikiProjectId } from '../../infrastructure/llm-wiki-client.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const apiBase = (process.env.LLM_WIKI_API_BASE_URL?.trim() || 'http://127.0.0.1:19928').replace(/\/$/, '')
const token = process.env.LLM_WIKI_API_TOKEN?.trim()
const wikiRoot = process.env.LLM_WIKI_MIRROR_ROOT || '/home/lgsj/llm-wiki/build/source2-home/userwiki-projects'
const timeoutMs = Number(process.env.LLM_WIKI_INDEX_TIMEOUT_MS ?? 120_000)
const maxAttempts = Math.max(1, Math.min(5, Number(process.env.LLM_WIKI_INDEX_ATTEMPTS ?? 3)))

export async function indexProjectDocumentInLlmWiki(projectId: string, documentId: string, versionId: string) {
  if (!token) throw new Error('llm_wiki_token_missing')
  const [version] = await db.select({ projectName: projects.name, documentName: documents.name, status: documents.status, parseStatus: documents.parseStatus, metadata: documents.metadata, versionNumber: documentVersions.versionNumber, checksum: documentVersions.checksum, isCurrent: documentVersions.isCurrent }).from(documentVersions).innerJoin(documents, eq(documents.id, documentVersions.documentId)).innerJoin(projects, eq(projects.id, documents.projectId)).where(and(eq(projects.id, projectId), eq(documents.id, documentId), eq(documentVersions.id, versionId))).limit(1)
  if (!version) return undefined
  if (!version.isCurrent) throw new Error('knowledge_version_not_current')
  if (['archived', 'obsolete'].includes(version.status)) throw new Error('knowledge_document_not_indexable')
  if (version.parseStatus !== 'completed') throw new Error('knowledge_document_not_parsed')
  const chunks = await db.select({ chunkIndex: documentChunks.chunkIndex, content: documentChunks.content }).from(documentChunks).where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.versionId, versionId))).orderBy(asc(documentChunks.chunkIndex))
  if (!chunks.length) throw new Error('knowledge_chunks_required')
  const wikiProjectId = await resolveLlmWikiProjectId(projectId, version.projectName)
  let pageCount = 0, wikiChunks = 0, vectorsWritten = 0
  await db.update(documents).set({ indexStatus: 'processing', aiEnabled: false, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
  try {
    for (let offset = 0; offset < chunks.length; offset += 4) {
      const pageNumber = Math.floor(offset / 4) + 1
      const relative = `wiki/knowledge-mirror/documents/${documentId}-${pageNumber}.md`
      const file = path.join(wikiRoot, wikiProjectId, relative)
      await mkdir(path.dirname(file), { recursive: true })
      const lines = [`# ${version.documentName}`, '', `> sourceProjectId: ${projectId}`, `> sourceDocumentId: ${documentId}`, `> sourceVersionId: ${versionId}`, `> sourceVersion: ${version.versionNumber}`, `> sourceChecksum: ${version.checksum ?? 'unknown'}`, '> sourceSystem: zhihui-project', '']
      for (const chunk of chunks.slice(offset, offset + 4)) lines.push(`### 源分块 ${chunk.chunkIndex}`, '', `<!-- sourceChunkId=${documentId}:${versionId}:${chunk.chunkIndex} -->`, chunk.content.trim(), '')
      await writeFile(file, lines.join('\n'), 'utf8')
      let indexed: { result?: { chunks?: number; vectorsWritten?: number } } | undefined
      let lastError = 'llm_wiki_embed_failed'
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await fetch(`${apiBase}/api/v1/projects/${encodeURIComponent(wikiProjectId)}/pages/embed`, { method: 'POST', signal: controller.signal, headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ path: relative, force: false }) })
          const text = await response.text(); if (!response.ok) throw new Error(`llm_wiki_embed_${response.status}`)
          indexed = JSON.parse(text) as { result?: { chunks?: number; vectorsWritten?: number } }; break
        } catch (error) {
          lastError = error instanceof Error && error.name === 'AbortError' ? 'llm_wiki_timeout' : error instanceof Error ? error.message : 'llm_wiki_embed_failed'
          if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 750 * attempt))
        } finally { clearTimeout(timer) }
      }
      if (!indexed) throw new Error(lastError)
      pageCount++; wikiChunks += Number(indexed.result?.chunks ?? 0); vectorsWritten += Number(indexed.result?.vectorsWritten ?? 0)
    }
    const previous = version.metadata.llmWikiSummary as { pages?: unknown; wikiProjectId?: unknown } | undefined
    const previousPages = Number(previous?.pages ?? 0)
    if (previous?.wikiProjectId === wikiProjectId && Number.isSafeInteger(previousPages) && previousPages > pageCount) {
      for (let pageNumber = pageCount + 1; pageNumber <= previousPages; pageNumber++) {
        const relative = `wiki/knowledge-mirror/documents/${documentId}-${pageNumber}.md`
        const response = await fetch(`${apiBase}/api/v1/projects/${encodeURIComponent(wikiProjectId)}/pages/index`, { method: 'DELETE', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ path: relative }) })
        if (!response.ok) throw new Error(`llm_wiki_delete_${response.status}`)
      }
    }
    const completedAt = new Date().toISOString()
    await db.update(documents).set({ indexStatus: 'completed', aiEnabled: true, metadata: { ...version.metadata, llmWikiSummary: { provider: 'llm-wiki', backend: 'lancedb', wikiProjectId, versionId, pages: pageCount, chunks: wikiChunks, vectorsWritten, completedAt } }, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
    await db.insert(auditLogs).values({ projectId, entityType: 'document', entityId: documentId, action: 'llm_wiki_indexed', actorName: 'system', changes: { version: version.versionNumber, wikiProjectId, pageCount, chunkCount: wikiChunks, vectorsWritten, summary: `完成 LLM Wiki 切片与向量化（${pageCount} 页，${wikiChunks} 个分块）` } })
    return { documentId, versionId, versionNumber: version.versionNumber, provider: 'llm-wiki', backend: 'lancedb', wikiProjectId, pageCount, chunkCount: wikiChunks, vectorsWritten }
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith('llm_wiki_') ? error.message : 'llm_wiki_index_failed'
    await db.update(documents).set({ indexStatus: 'failed', aiEnabled: false, metadata: { ...version.metadata, llmWikiError: { code, versionId, failedAt: new Date().toISOString() } }, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId))).catch(() => undefined)
    throw new Error(code)
  }
}

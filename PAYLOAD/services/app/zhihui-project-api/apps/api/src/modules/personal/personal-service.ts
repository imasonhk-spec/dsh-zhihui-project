import { and, asc, cosineDistance, eq, gte, ilike, lte, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '../../db/client.ts'
import { putKnowledgeObject } from '../../infrastructure/object-storage.ts'
import { EMBEDDING_MODEL, EMBEDDING_PROVIDER, embedTexts, embeddingContentHash } from '../../infrastructure/embedding-client.ts'
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from '../knowledge/vector-store-service.ts'
import { documents, documentChunks, documentVersions, knowledgeBases, knowledgeFolders, personalMemoryEntries, personalReports } from '../../db/schema.ts'

const ACCOUNT_ID = /^[a-z][a-z0-9_-]{1,31}$/
const FOLDERS = ['00-个人资料','01-长期记忆','02-对话摘要','03-日报','04-周报','05-月报','06-上传资料','07-项目驾驶舱','99-系统日志']
export function validateAccountId(accountId: string) { if (!ACCOUNT_ID.test(accountId)) throw new Error('personal_account_id_invalid') }
export async function ensurePersonalKnowledgeWorkspace(accountId: string) {
  validateAccountId(accountId)
  const existing = await db.select().from(knowledgeBases).where(eq(knowledgeBases.accountId, accountId)).limit(1)
  let base = existing[0]
  if (!base) {
    try { [base] = await db.insert(knowledgeBases).values({ accountId, name: `${accountId}个人知识库`, description: '微信账号个人记忆与周期报告知识库', scope: 'personal' }).returning() }
    catch { [base] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.accountId, accountId)).limit(1) }
  }
  if (!base) throw new Error('personal_knowledge_base_create_failed')
  const folders = await db.select().from(knowledgeFolders).where(eq(knowledgeFolders.knowledgeBaseId, base.id)).orderBy(asc(knowledgeFolders.sortOrder))
  if (folders.length < FOLDERS.length) for (let i = 0; i < FOLDERS.length; i++) if (!folders.some(folder => folder.path === FOLDERS[i])) await db.insert(knowledgeFolders).values({ knowledgeBaseId: base.id, name: FOLDERS[i]!, path: FOLDERS[i]!, sortOrder: i }).onConflictDoNothing()
  return { ...base, folders: await db.select().from(knowledgeFolders).where(eq(knowledgeFolders.knowledgeBaseId, base.id)).orderBy(asc(knowledgeFolders.sortOrder)) }
}
export async function listPersonalMemories(accountId: string) { const base = await ensurePersonalKnowledgeWorkspace(accountId); return db.select().from(personalMemoryEntries).where(and(eq(personalMemoryEntries.accountId, accountId), eq(personalMemoryEntries.knowledgeBaseId, base.id), eq(personalMemoryEntries.status, 'active'))).orderBy(asc(personalMemoryEntries.occurredAt)) }
export async function addPersonalMemory(accountId: string, input: { content: string; category?: string; sourceType?: string; sourceId?: string; occurredAt?: string; importance?: number }) { const base = await ensurePersonalKnowledgeWorkspace(accountId); if (!input.content?.trim() || input.content.length > 20000) throw new Error('personal_memory_content_invalid'); const [row] = await db.insert(personalMemoryEntries).values({ accountId, knowledgeBaseId: base.id, content: input.content.trim(), category: input.category ?? 'general', sourceType: input.sourceType, sourceId: input.sourceId, occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(), importance: input.importance ?? 3 }).returning(); return row }
function range(period: 'daily'|'weekly'|'monthly', dateText?: string) { const d = dateText ? new Date(`${dateText}T00:00:00Z`) : new Date(); if (Number.isNaN(d.getTime())) throw new Error('personal_report_date_invalid'); const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const start = period === 'daily' ? end : period === 'weekly' ? new Date(end.getTime() - 6 * 86400000) : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)); const finish = period === 'monthly' ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)) : end; return { start: start.toISOString().slice(0,10), end: finish.toISOString().slice(0,10) } }
export async function generatePersonalReport(accountId: string, period: 'daily'|'weekly'|'monthly', dateText?: string) {
  const base = await ensurePersonalKnowledgeWorkspace(accountId); const r = range(period, dateText)
  const entries = await db.select().from(personalMemoryEntries).where(and(eq(personalMemoryEntries.accountId, accountId), eq(personalMemoryEntries.knowledgeBaseId, base.id), gte(personalMemoryEntries.occurredAt, new Date(`${r.start}T00:00:00Z`)), lte(personalMemoryEntries.occurredAt, new Date(`${r.end}T23:59:59.999Z`)))).orderBy(asc(personalMemoryEntries.occurredAt))
  const lines = entries.length ? entries.map(item => `- [${item.category}] ${item.content}`).join('\\n') : '- 暂无记录'
  const title = `${r.start}至${r.end}${period === 'daily' ? '日报' : period === 'weekly' ? '周报' : '月报'}`
  const content = `# ${title}\\n\\n## 记录汇总\\n${lines}`
  const [embedding] = await embedTexts([content])
  if (!embedding || embedding.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS) throw new Error('personal_report_embedding_invalid')
  const [row] = await db.insert(personalReports).values({ accountId, knowledgeBaseId: base.id, period, periodStart: r.start, periodEnd: r.end, title, summary: `共 ${entries.length} 条个人记录`, content, sourceSnapshot: { entryIds: entries.map(item => item.id), count: entries.length, range: r } }).onConflictDoUpdate({ target: [personalReports.accountId, personalReports.period, personalReports.periodStart], set: { periodEnd: r.end, title, summary: `共 ${entries.length} 条个人记录`, content, sourceSnapshot: { entryIds: entries.map(item => item.id), count: entries.length, range: r }, updatedAt: new Date() } }).returning()
  const folderPath = period === 'daily' ? '03-日报' : period === 'weekly' ? '04-周报' : '05-月报'
  const reportKey = `personal/${accountId}/reports/${row.id}.md`
  await putKnowledgeObject({ key: reportKey, body: Buffer.from(content, 'utf8'), contentType: 'text/markdown; charset=utf-8', contentLength: Buffer.byteLength(content) })
  const folder = (await db.select().from(knowledgeFolders).where(and(eq(knowledgeFolders.knowledgeBaseId, base.id), eq(knowledgeFolders.path, folderPath))).limit(1))[0]
  if (!folder) throw new Error('personal_report_folder_missing')
  await db.transaction(async tx => {
    const existing = (await tx.select().from(documents).where(and(eq(documents.knowledgeBaseId, base.id), eq(documents.name, title))).limit(1))[0]
    let documentId = existing?.id
    let versionId = existing ? (await tx.select().from(documentVersions).where(and(eq(documentVersions.documentId, existing.id), eq(documentVersions.isCurrent, true))).limit(1))[0]?.id : undefined
    if (!existing) {
      documentId = randomUUID(); versionId = randomUUID()
      await tx.insert(documents).values({ id: documentId, knowledgeBaseId: base.id, folderId: folder.id, name: title, originalName: `${title}.md`, fileType: 'md', mimeType: 'text/markdown; charset=utf-8', fileSize: Buffer.byteLength(content), checksum: null, storageKey: reportKey, version: 'v1', status: 'confirmed', parseStatus: 'completed', indexStatus: 'completed', aiEnabled: true, metadata: { accountId, personalReportId: row.id, period, periodStart: r.start } })
      await tx.insert(documentVersions).values({ id: versionId, documentId, versionNumber: 'v1', storageKey: reportKey, fileSize: Buffer.byteLength(content), mimeType: 'text/markdown; charset=utf-8', originalName: `${title}.md`, isCurrent: true })
    } else if (versionId) {
      await tx.update(documents).set({ folderId: folder.id, fileSize: Buffer.byteLength(content), status: 'confirmed', parseStatus: 'completed', indexStatus: 'completed', aiEnabled: true, metadata: { ...existing.metadata, accountId, personalReportId: row.id, period, periodStart: r.start }, updatedAt: new Date() }).where(eq(documents.id, documentId!))
    }
    if (documentId && versionId) {
      await tx.delete(documentChunks).where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.versionId, versionId)))
      await tx.insert(documentChunks).values({ documentId, versionId, chunkIndex: 0, title, content, sectionPath: folderPath, embedding, metadata: { accountId, personalReportId: row.id, period, source: 'personal_reports', embedding: { provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL, dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS, contentHash: embeddingContentHash(content) } } })
    }
  })
  return row
}

export async function searchPersonalKnowledge(accountId: string, query: string, limit = 20) {
  const base = await ensurePersonalKnowledgeWorkspace(accountId); const needle = query.trim()
  if (!needle) throw new Error('personal_knowledge_query_invalid')
  const bounded = Math.max(1, Math.min(50, limit))
  const memoryHits = await db.select({ id: personalMemoryEntries.id, category: personalMemoryEntries.category, content: personalMemoryEntries.content, sourceType: personalMemoryEntries.sourceType, sourceId: personalMemoryEntries.sourceId, occurredAt: personalMemoryEntries.occurredAt, metadata: personalMemoryEntries.metadata }).from(personalMemoryEntries).where(and(eq(personalMemoryEntries.accountId, accountId), eq(personalMemoryEntries.knowledgeBaseId, base.id), eq(personalMemoryEntries.status, 'active'), ilike(personalMemoryEntries.content, `%${needle}%`))).orderBy(asc(personalMemoryEntries.occurredAt)).limit(bounded)
  const [queryEmbedding] = await embedTexts([needle])
  if (!queryEmbedding || queryEmbedding.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS) throw new Error('personal_knowledge_query_embedding_invalid')
  const distance = cosineDistance(documentChunks.embedding, queryEmbedding)
  const documentHits = await db.select({ documentId: documents.id, name: documents.name, folderId: documents.folderId, chunkId: documentChunks.id, content: documentChunks.content, metadata: documentChunks.metadata, score: sql<number>`1 - (${distance})` }).from(documentChunks).innerJoin(documents, eq(documents.id, documentChunks.documentId)).where(and(eq(documents.knowledgeBaseId, base.id), eq(documents.aiEnabled, true), sql`${documentChunks.embedding} is not null`)).orderBy(distance).limit(bounded)
  return [
    ...memoryHits.map(hit => ({ documentId: null, name: hit.category, folderId: null, chunkId: hit.id, content: hit.content, metadata: { ...hit.metadata, source: 'personal_memory_entries', sourceType: hit.sourceType, sourceId: hit.sourceId, occurredAt: hit.occurredAt }, score: 1 })),
    ...documentHits,
  ].slice(0, bounded)
}
export async function listPersonalReports(accountId: string, period?: 'daily'|'weekly'|'monthly') { const base = await ensurePersonalKnowledgeWorkspace(accountId); return db.select().from(personalReports).where(and(eq(personalReports.accountId, accountId), eq(personalReports.knowledgeBaseId, base.id), period ? eq(personalReports.period, period) : sql`true`)).orderBy(asc(personalReports.periodStart)) }

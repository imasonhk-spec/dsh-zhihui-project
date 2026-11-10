import { getProjectKnowledgeDocument, listProjectKnowledgeDocumentVersions } from './knowledge-service.ts'
import { parseProjectKnowledgeDocumentVersion } from './document-processing-service.ts'
import { embedProjectDocumentVersion } from './embedding-service.ts'
import { indexProjectDocumentInLlmWiki } from './llm-wiki-index-service.ts'

/**
 * 文档解析与双路索引统一入口。
 *
 * 系统存在两条互不覆盖的检索路径，必须同时建立索引，否则会出现“状态显示已完成、
 * 但某条路径搜不到”的隐性缺陷：
 * - pgvector 混合检索：AI 问答链路（ai-stream-service → prepareProjectRag →
 *   searchAllProjectsKnowledgeHybrid）默认使用，SQL 要求
 *   parse_status='completed' AND index_status='completed' AND ai_enabled=true AND embedding IS NOT NULL。
 * - LLM Wiki（LanceDB）：知识检索接口（server.ts）对非 OPP-MASTER 项目优先使用。
 *
 * 执行顺序刻意安排为 Wiki 先、pgvector 后：两个索引函数都会写 documents 的
 * index_status / ai_enabled，且失败时写 'failed' + ai_enabled=false。把 pgvector 放在最后，
 * 可使 AI 问答依赖的状态由它最终决定，避免 Wiki 失败连带废掉已成功的向量检索。
 *
 * 失败策略：任一路径失败记入 warnings 并继续；仅当两条路径都失败时抛错（文档完全不可检索）。
 * LLM Wiki 未配置令牌属于预期情况，只产生 warning，不影响导入成功。
 */
export type DocumentIndexWarning = { stage: 'llm-wiki' | 'pgvector'; message: string }
export type DocumentParseOutcome = Awaited<ReturnType<typeof parseProjectKnowledgeDocumentVersion>> | { chunkCount: null; skipped: true }
export type DocumentIndexResult = {
  documentId: string
  versionId: string
  versionNumber?: string
  parsed?: DocumentParseOutcome
  embedded?: Awaited<ReturnType<typeof embedProjectDocumentVersion>>
  wiki?: Awaited<ReturnType<typeof indexProjectDocumentInLlmWiki>>
  warnings: DocumentIndexWarning[]
}

export async function parseAndIndexProjectDocument(projectId: string, documentId: string): Promise<DocumentIndexResult> {
  const current = await getProjectKnowledgeDocument(projectId, documentId)
  if (!current) throw new Error('knowledge_document_not_found')
  const versions = await listProjectKnowledgeDocumentVersions(projectId, documentId)
  const version = versions?.find(item => item.isCurrent)
  if (!version) throw new Error('knowledge_version_not_found')

  const parsed: DocumentParseOutcome | undefined = current.parseStatus === 'completed'
    ? { chunkCount: null, skipped: true }
    : await parseProjectKnowledgeDocumentVersion(projectId, documentId, version.id)

  const warnings: DocumentIndexWarning[] = []

  let wiki: DocumentIndexResult['wiki']
  try {
    wiki = await indexProjectDocumentInLlmWiki(projectId, documentId, version.id)
  } catch (error) {
    warnings.push({ stage: 'llm-wiki', message: error instanceof Error ? error.message : String(error) })
  }

  let embedded: DocumentIndexResult['embedded']
  try {
    embedded = await embedProjectDocumentVersion(projectId, documentId, version.id)
  } catch (error) {
    warnings.push({ stage: 'pgvector', message: error instanceof Error ? error.message : String(error) })
  }

  if (!wiki && !embedded) {
    throw new Error(`knowledge_index_failed:${warnings.map(item => `${item.stage}=${item.message}`).join(';')}`)
  }

  return { documentId, versionId: version.id, versionNumber: version.versionNumber, parsed, embedded, wiki, warnings }
}

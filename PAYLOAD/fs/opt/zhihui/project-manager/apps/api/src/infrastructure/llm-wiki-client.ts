import 'dotenv/config'

export type LlmWikiHealth = { ok: boolean; status?: string; version?: string; authRequired?: boolean; authConfigured?: boolean; enabled?: boolean; [key: string]: unknown }
type JsonObject = Record<string, unknown>
type WikiProject = { id: string; name: string; path?: string }

const baseUrl = (process.env.LLM_WIKI_API_BASE_URL?.trim() || 'http://127.0.0.1:19928').replace(/\/$/, '')
const token = process.env.LLM_WIKI_API_TOKEN?.trim()
const timeoutMs = Number(process.env.LLM_WIKI_TIMEOUT_MS ?? 15_000)
let projectCache: { expiresAt: number; projects: WikiProject[] } | undefined

export function isLlmWikiConfigured() { return Boolean(token) }
export async function llmWikiHealth(): Promise<LlmWikiHealth> { return request('/api/v1/health', { auth: false }) as Promise<LlmWikiHealth> }
export async function llmWikiProjects() { return request('/api/v1/projects') }

export async function resolveLlmWikiProjectId(sourceProjectId: string, sourceProjectName?: string) {
  const projects = await cachedProjects()
  const direct = projects.find(project => project.id === sourceProjectId)
  if (direct) return direct.id
  const expectedName = sourceProjectName ? `项目知识库-${sourceProjectName}` : ''
  const matches = expectedName ? projects.filter(project => project.name === expectedName) : []
  if (matches.length !== 1) throw new Error(matches.length ? 'llm_wiki_project_ambiguous' : 'llm_wiki_project_not_found')
  return matches[0]!.id
}

export async function llmWikiSearch(projectId: string, query: string, options: { topK?: number; includeContent?: boolean } = {}) {
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/search`, { method: 'POST', body: { query, topK: options.topK, includeContent: options.includeContent } })
}

export async function llmWikiPrimarySearch(sourceProjectId: string, query: string, options: { topK?: number; projectName?: string } = {}) {
  const wikiProjectId = await resolveLlmWikiProjectId(sourceProjectId, options.projectName)
  const value = await llmWikiSearch(wikiProjectId, query, { topK: options.topK ?? 8, includeContent: true }) as { results?: Array<Record<string, unknown>>; mode?: string }
  const items = (value.results ?? []).map((hit, index) => {
    const path = String(hit.path ?? '')
    const source = String(hit.content ?? hit.snippet ?? '')
    const marker = /sourceChunkId=([^\s>]+)/.exec(source)
    return {
      chunkId: marker?.[1] ?? `llm-wiki:${wikiProjectId}:${path}:${index}`,
      documentId: `llm-wiki:${wikiProjectId}:${path}`,
      documentName: String(hit.title ?? path.split('/').pop() ?? 'LLM Wiki 文档'), originalName: String(hit.title ?? path.split('/').pop() ?? 'LLM Wiki 文档'),
      fileType: 'md', status: 'confirmed', folderId: null, folderPath: path.split('/').slice(0, -1).join('/') || null,
      versionId: 'llm-wiki', versionNumber: 'current', chunkIndex: index, pageNumber: null, sectionPath: String(hit.headingPath ?? '') || null,
      content: source, snippet: String(hit.snippet ?? source).slice(0, 500), highlights: [], semanticScore: Number(hit.vectorScore ?? hit.score ?? 0), keywordRank: Number(hit.score ?? 0), score: Number(hit.score ?? hit.vectorScore ?? 0), matchedBy: ['llm-wiki'], metadata: { sourcePath: path, sourceProjectId, llmWikiProjectId: wikiProjectId }, updatedAt: new Date(),
    }
  })
  return { query, mode: value.mode ?? 'hybrid', total: items.length, limit: options.topK ?? 8, offset: 0, minScore: 0, source: 'llm-wiki' as const, wikiProjectId, items }
}

export async function llmWikiChat(projectId: string, message: string, options: { sessionId?: string; topK?: number; stream?: boolean } = {}) {
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/chat`, { method: 'POST', body: { message, sessionId: options.sessionId, topK: options.topK, stream: options.stream ?? false } })
}

async function cachedProjects() {
  if (projectCache && projectCache.expiresAt > Date.now()) return projectCache.projects
  const value = await llmWikiProjects() as { projects?: WikiProject[] }
  const projects = Array.isArray(value.projects) ? value.projects : []
  projectCache = { expiresAt: Date.now() + 60_000, projects }
  return projects
}

async function request(path: string, options: { method?: string; body?: JsonObject; auth?: boolean } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    if (options.auth !== false && !token) throw new Error('llm_wiki_token_missing')
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.body) headers['content-type'] = 'application/json'
    if (options.auth !== false && token) headers.authorization = `Bearer ${token}`
    const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? 'GET', headers, signal: controller.signal, body: options.body ? JSON.stringify(options.body) : undefined })
    const text = await response.text(); let value: unknown = {}
    try { value = text ? JSON.parse(text) : {} } catch { throw new Error('llm_wiki_response_invalid') }
    if (!response.ok) throw new Error(`llm_wiki_http_${response.status}`)
    return value as JsonObject
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('llm_wiki_') || error.name === 'AbortError')) throw new Error(error.name === 'AbortError' ? 'llm_wiki_timeout' : error.message)
    throw new Error('llm_wiki_unavailable')
  } finally { clearTimeout(timer) }
}

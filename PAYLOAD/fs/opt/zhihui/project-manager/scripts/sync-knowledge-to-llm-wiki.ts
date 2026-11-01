import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '../apps/api/src/db/client.ts'

type Row = { project_id: string; project_name: string; document_id: string; document_name: string; version_id: string; version_number: string; checksum: string | null; chunk_index: number; content: string }
type PageJob = { projectId: string; projectName: string; pageNumber: number; rows: Row[] }

const apiBase = (process.env.LLM_WIKI_API_BASE_URL || 'http://127.0.0.1:19928').replace(/\/$/, '')
const token = process.env.LLM_WIKI_API_TOKEN?.trim()
const wikiRoot = process.env.LLM_WIKI_MIRROR_ROOT || '/home/lgsj/llm-wiki/build/source2-home/userwiki-projects'
const fixedWikiProjectId = process.env.LLM_WIKI_PROJECT_ID?.trim() || ''
const projectFilter = process.env.LLM_WIKI_PROJECT_FILTER?.trim()
const pageFilter = new Set((process.env.LLM_WIKI_PAGE_FILTER || '').split(',').map(value => value.trim()).filter(Boolean).map(Number).filter(Number.isFinite))
const force = process.env.LLM_WIKI_SYNC_FORCE !== 'false'
const concurrency = Math.max(1, Math.min(2, Number(process.env.LLM_WIKI_SYNC_CONCURRENCY || 1)))
const maxAttempts = Math.max(1, Math.min(5, Number(process.env.LLM_WIKI_SYNC_ATTEMPTS || 3)))
if (!token) throw new Error('llm_wiki_token_missing')

const result = await pool.query<Row>(`select p.id project_id, p.name project_name, d.id document_id, d.name document_name,
  dv.id version_id, dv.version_number, dv.checksum, dc.chunk_index, dc.content
from projects p
join documents d on d.project_id=p.id and d.status not in ('archived','obsolete')
join document_versions dv on dv.document_id=d.id and dv.is_current=true
join document_chunks dc on dc.document_id=d.id and dc.version_id=dv.id
where d.parse_status='completed' and d.ai_enabled=true
order by p.id, d.id, dc.chunk_index`)

const projects = new Map<string, Row[]>()
for (const row of result.rows) projects.set(row.project_id, [...(projects.get(row.project_id) ?? []), row])
const jobs: PageJob[] = []
for (const [projectId, rows] of projects) {
  if (projectFilter && projectId !== projectFilter) continue
  for (let offset = 0; offset < rows.length; offset += 4) {
    const pageNumber = Math.floor(offset / 4) + 1
    if (pageFilter.size && !pageFilter.has(pageNumber)) continue
    jobs.push({ projectId, projectName: rows[0]!.project_name, pageNumber, rows: rows.slice(offset, offset + 4) })
  }
}

const headers = { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` }
const registryResponse = await fetch(`${apiBase}/api/v1/projects`, { headers })
if (!registryResponse.ok) throw new Error(`llm_wiki_projects_${registryResponse.status}`)
const registry = await registryResponse.json() as { projects?: Array<{ id: string; name: string }> }
const wikiProjects = registry.projects ?? []
function targetProjectId(job: PageJob) {
  if (fixedWikiProjectId) return fixedWikiProjectId
  if (wikiProjects.some(project => project.id === job.projectId)) return job.projectId
  const matches = wikiProjects.filter(project => project.name === `项目知识库-${job.projectName}`)
  if (matches.length !== 1) throw new Error(matches.length ? `llm_wiki_project_ambiguous:${job.projectName}` : `llm_wiki_project_not_found:${job.projectName}`)
  return matches[0]!.id
}
let embedded = 0
let unchanged = 0
let vectorsWritten = 0
let failed = 0
const failures: string[] = []

async function run(job: PageJob) {
  const targetWikiProjectId = targetProjectId(job)
  const relative = `wiki/knowledge-mirror/${job.projectId}-${job.pageNumber}.md`
  const file = path.join(wikiRoot, targetWikiProjectId, relative)
  await mkdir(path.dirname(file), { recursive: true })
  const lines = [`# 项目知识库镜像：${job.projectName}`, '', `> projectId: ${job.projectId}`, `> mirrorPage: ${job.pageNumber}`, '> sourceSystem: zhihui-project', '> 数据范围：当前有效版本；不包含账号凭据、Token或控制面数据。', '']
  let lastDocument = ''
  for (const row of job.rows) {
    if (row.document_id !== lastDocument) {
      lines.push(`## 文档：${row.document_name}`, '', `- documentId: ${row.document_id}`, `- versionId: ${row.version_id}`, `- version: ${row.version_number}`, `- checksum: ${row.checksum ?? 'unknown'}`, '')
      lastDocument = row.document_id
    }
    lines.push(`### 源分块 ${row.chunk_index}`, '', `<!-- sourceChunkId=${row.document_id}:${row.version_id}:${row.chunk_index} -->`, row.content.trim(), '')
  }
  await writeFile(file, lines.join('\n'), 'utf8')
  let lastError = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${apiBase}/api/v1/projects/${encodeURIComponent(targetWikiProjectId)}/pages/embed`, { method: 'POST', headers, body: JSON.stringify({ path: relative, force }) })
      const text = await response.text()
      if (!response.ok) throw new Error(`llm_wiki_embed_${response.status}:${text.slice(0, 300)}`)
      const value = JSON.parse(text) as { result?: { chunks?: number; vectorsWritten?: number; status?: string } }
      const page = value.result ?? {}
      if (page.status === 'unchanged') unchanged++; else embedded++
      vectorsWritten += Number(page.vectorsWritten ?? 0)
      console.log(JSON.stringify({ projectId: job.projectId, path: relative, sourceChunks: job.rows.length, wikiChunks: page.chunks ?? null, vectorsWritten: page.vectorsWritten ?? null, status: page.status ?? 'indexed', attempt }))
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 750 * attempt))
    }
  }
  failed++
  failures.push(`${job.projectId}:${relative}:${lastError}`)
  console.error(JSON.stringify({ projectId: job.projectId, path: relative, embedded: false, error: lastError }))
}

for (let i = 0; i < jobs.length; i += concurrency) await Promise.all(jobs.slice(i, i + concurrency).map(run))
await pool.end()
if (failed) process.exitCode = 1
console.log(JSON.stringify({ ok: failed === 0, sourceProjects: new Set(jobs.map(job => job.projectId)).size, sourceChunks: result.rows.length, pages: jobs.length, pagesEmbedded: embedded, pagesUnchanged: unchanged, vectorsWritten, failed, failures, wikiProjectIds: fixedWikiProjectId || 'source project IDs' }))

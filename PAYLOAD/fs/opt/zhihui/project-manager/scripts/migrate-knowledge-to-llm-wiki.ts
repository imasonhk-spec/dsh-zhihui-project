import 'dotenv/config'
import { pool } from '../apps/api/src/db/client.ts'
import { indexProjectDocumentInLlmWiki } from '../apps/api/src/modules/knowledge/llm-wiki-index-service.ts'

type Row = { project_id: string; document_id: string; version_id: string; project_name: string; document_name: string }
const projectFilter = process.env.LLM_WIKI_PROJECT_FILTER?.trim()
const rows = await pool.query<Row>(`select p.id project_id,p.name project_name,d.id document_id,d.name document_name,dv.id version_id
from projects p join documents d on d.project_id=p.id and d.status not in ('archived','obsolete')
join document_versions dv on dv.document_id=d.id and dv.is_current=true
where d.parse_status='completed' order by p.code,d.id`)
let completed = 0, failed = 0
const failures: Array<{ projectId: string; documentId: string; error: string }> = []
for (const row of rows.rows) {
  if (projectFilter && row.project_id !== projectFilter) continue
  try {
    const result = await indexProjectDocumentInLlmWiki(row.project_id, row.document_id, row.version_id)
    completed++
    console.log(JSON.stringify({ ok: true, projectId: row.project_id, projectName: row.project_name, documentId: row.document_id, documentName: row.document_name, pages: result?.pageCount, chunks: result?.chunkCount, vectorsWritten: result?.vectorsWritten }))
  } catch (error) {
    failed++
    const message = error instanceof Error ? error.message : String(error)
    failures.push({ projectId: row.project_id, documentId: row.document_id, error: message })
    console.error(JSON.stringify({ ok: false, projectId: row.project_id, documentId: row.document_id, error: message }))
  }
}
await pool.end()
if (failed) process.exitCode = 1
console.log(JSON.stringify({ ok: failed === 0, documents: completed + failed, completed, failed, failures }))

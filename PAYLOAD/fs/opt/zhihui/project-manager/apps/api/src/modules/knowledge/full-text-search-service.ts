import { sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'

export type KnowledgeContentSearchFilters = {
  q?: string
  folderId?: string
  fileType?: string
  status?: string
  updatedFrom?: string
  updatedTo?: string
  includeArchived?: string
  limit?: string
  offset?: string
}

const statuses = new Set(['draft', 'reviewing', 'confirmed', 'archived'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function searchProjectKnowledgeContent(projectId: string, raw: KnowledgeContentSearchFilters) {
  if (!UUID_PATTERN.test(projectId)) throw new Error('project_id_invalid')
  const input = validate(raw)
  const queryText = input.terms.join(' & ')
  const substringClauses = input.terms.map(term => sql`lower(coalesce(dc.title, '') || ' ' || dc.content) like ${`%${escapeLike(term)}%`} escape '\\'`)
  const matchFilter = substringClauses.length ? sql`(dc.search_vector @@ query.value or (${sql.join(substringClauses, sql` and `)}))` : sql`dc.search_vector @@ query.value`
  const includeArchived = input.includeArchived || input.status === 'archived'
  const statusFilter = input.status ? sql`and d.status = ${input.status}` : includeArchived ? sql`and d.status <> 'obsolete'` : sql`and d.status not in ('archived', 'obsolete')`
  const folderFilter = input.folderId ? sql`and d.folder_id = ${input.folderId}::uuid` : sql``
  const typeFilter = input.fileType ? sql`and lower(d.file_type) = ${input.fileType}` : sql``
  const fromFilter = input.updatedFrom ? sql`and d.updated_at >= ${input.updatedFrom}::timestamptz` : sql``
  const toFilter = input.updatedTo ? sql`and d.updated_at < (${input.updatedTo}::date + interval '1 day')` : sql``

  const rows = await db.execute<{
    chunk_id: string; document_id: string; source_project_id: string; source_project_code: string; document_name: string; original_name: string; file_type: string; status: string; folder_id: string | null; folder_path: string | null;
    version_id: string; version_number: string; checksum: string | null; chunk_index: number; page_number: number | null; section_path: string | null; content: string; metadata: Record<string, unknown>;
    updated_at: Date; rank: number; total_count: string;
  }>(sql`
    with query as (select to_tsquery('simple', ${queryText}) as value), candidates as (
      select dc.id as chunk_id, d.id as document_id, d.project_id as source_project_id, p.code as source_project_code, d.name as document_name, d.original_name, d.file_type, d.status,
        d.folder_id, kf.path as folder_path, dv.id as version_id, dv.version_number, coalesce(dv.checksum, d.checksum) as checksum, dc.chunk_index, dc.page_number, dc.section_path,
        dc.content, dc.metadata, d.updated_at,
        greatest(ts_rank_cd(dc.search_vector, query.value, 32), case when ${sql.join(substringClauses, sql` and `)} then 0.2 else 0 end) as rank
      from document_chunks dc
      join documents d on d.id = dc.document_id
      join projects p on p.id = d.project_id
      join document_versions dv on dv.id = dc.version_id and dv.document_id = d.id
      left join knowledge_folders kf on kf.id = d.folder_id and kf.knowledge_base_id = d.knowledge_base_id
      cross join query
      where d.project_id = ${projectId}::uuid and dv.is_current = true and d.parse_status = 'completed'
        and ${matchFilter} ${statusFilter} ${folderFilter} ${typeFilter} ${fromFilter} ${toFilter}
    )
    select *, count(*) over()::text as total_count from candidates
    order by rank desc, updated_at desc, chunk_id asc
    limit ${input.limit} offset ${input.offset}
  `)
  const total = Number(rows.rows[0]?.total_count ?? 0)
  return {
    query: input.q,
    terms: input.terms,
    total,
    limit: input.limit,
    offset: input.offset,
    items: rows.rows.map(row => ({
      chunkId: row.chunk_id, documentId: row.document_id, sourceProjectId: row.source_project_id, sourceProjectCode: row.source_project_code, documentName: row.document_name, originalName: row.original_name,
      fileType: row.file_type, status: row.status, folderId: row.folder_id, folderPath: row.folder_path,
      versionId: row.version_id, versionNumber: row.version_number, checksum: row.checksum, chunkIndex: row.chunk_index, pageNumber: row.page_number,
      sectionPath: row.section_path, snippet: buildSnippet(row.content, input.terms), highlights: input.terms,
      rank: Number(row.rank), metadata: row.metadata, updatedAt: row.updated_at,
    })),
  }
}

function validate(raw: KnowledgeContentSearchFilters) {
  const allowed = new Set(['q', 'folderId', 'fileType', 'status', 'updatedFrom', 'updatedTo', 'includeArchived', 'limit', 'offset'])
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error('knowledge_search_field_invalid')
  const q = raw.q?.normalize('NFKC').trim() ?? ''
  if (q.length < 2 || q.length > 200 || /[\u0000-\u001f]/.test(q)) throw new Error('knowledge_search_query_invalid')
  const terms = [...new Set(q.match(/[\p{Script=Han}]|[\p{Letter}\p{Number}_-]+/gu)?.map(value => value.toLocaleLowerCase()).filter(value => value.length > 0) ?? [])].slice(0, 20)
  if (!terms.length) throw new Error('knowledge_search_query_invalid')
  if (raw.folderId && !UUID_PATTERN.test(raw.folderId)) throw new Error('knowledge_folder_id_invalid')
  const fileType = raw.fileType?.replace(/^\./, '').trim().toLowerCase()
  if (fileType && !/^[a-z0-9]{1,12}$/.test(fileType)) throw new Error('knowledge_search_file_type_invalid')
  const status = raw.status?.trim()
  if (status && !statuses.has(status)) throw new Error('knowledge_search_status_invalid')
  const updatedFrom = parseDate(raw.updatedFrom, 'knowledge_search_date_invalid')
  const updatedTo = parseDate(raw.updatedTo, 'knowledge_search_date_invalid')
  if (updatedFrom && updatedTo && updatedFrom > updatedTo) throw new Error('knowledge_search_date_range_invalid')
  const includeArchived = raw.includeArchived === 'true'
  if (raw.includeArchived && !['true', 'false'].includes(raw.includeArchived)) throw new Error('knowledge_search_include_archived_invalid')
  const limit = parseInteger(raw.limit, 20, 1, 50, 'knowledge_search_limit_invalid')
  const offset = parseInteger(raw.offset, 0, 0, 10_000, 'knowledge_search_offset_invalid')
  return { q, terms, folderId: raw.folderId, fileType, status, updatedFrom, updatedTo, includeArchived, limit, offset }
}
function escapeLike(value: string) { return value.replace(/[\\%_]/g, match => `\\${match}`) }
function parseDate(value: string | undefined, code: string) { if (!value) return undefined; if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(code); return value }
function parseInteger(value: string | undefined, fallback: number, min: number, max: number, code: string) { if (value === undefined) return fallback; const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(code); return parsed }
function buildSnippet(content: string, terms: string[]) {
  const normalized = content.toLocaleLowerCase(); let index = -1
  for (const term of terms) { const next = normalized.indexOf(term); if (next >= 0 && (index < 0 || next < index)) index = next }
  if (index < 0) index = 0
  const start = Math.max(0, index - 90), end = Math.min(content.length, index + 260)
  return `${start > 0 ? '…' : ''}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${end < content.length ? '…' : ''}`
}

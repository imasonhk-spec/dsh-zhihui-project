import { sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { embedTexts } from '../../infrastructure/embedding-client.ts'
import { authorizePortfolioKnowledge } from './knowledge-authorization.ts'
import { authorizedProjectKnowledgePredicate } from './hybrid-search-scope.ts'

export type HybridSearchInput = { q?: unknown; mode?: unknown; folderId?: unknown; fileType?: unknown; status?: unknown; updatedFrom?: unknown; updatedTo?: unknown; includeArchived?: unknown; limit?: unknown; offset?: unknown; minScore?: unknown }
type SearchMode = 'semantic' | 'hybrid'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const statuses = new Set(['draft', 'reviewing', 'confirmed', 'archived'])

export async function searchAllProjectsKnowledgeHybrid(projectId:string,raw:HybridSearchInput){
  const scope=await authorizePortfolioKnowledge(projectId)
  if(scope.portfolioProjectId!==projectId||scope.scope!=='authorized-project-set')throw new Error('knowledge_portfolio_forbidden')
  return searchKnowledgeHybrid(raw,scope.authorizedProjectIds)
}

export async function searchProjectKnowledgeHybrid(projectId: string, raw: HybridSearchInput) {
  if (!UUID_PATTERN.test(projectId)) throw new Error('project_id_invalid')
  const input = validate(raw), [embedding] = await embedTexts([input.q])
  const vector = JSON.stringify(embedding), queryText = input.terms.join(' & ')
  const substrings = input.terms.map(term => sql`lower(coalesce(dc.title, '') || ' ' || dc.content) like ${`%${escapeLike(term)}%`} escape '\\'`)
  const lexicalMatch = sql`(dc.search_vector @@ query.value or (${sql.join(substrings, sql` and `)}))`
  const includeArchived = input.includeArchived || input.status === 'archived'
  const statusFilter = input.status ? sql`and d.status = ${input.status}` : includeArchived ? sql`and d.status <> 'obsolete'` : sql`and d.status not in ('archived', 'obsolete')`
  const filters = sql`${statusFilter} ${input.folderId ? sql`and d.folder_id = ${input.folderId}::uuid` : sql``} ${input.fileType ? sql`and lower(d.file_type) = ${input.fileType}` : sql``} ${input.updatedFrom ? sql`and d.updated_at >= ${input.updatedFrom}::timestamptz` : sql``} ${input.updatedTo ? sql`and d.updated_at < (${input.updatedTo}::date + interval '1 day')` : sql``}`
  const rows = await db.execute<{ chunk_id:string;document_id:string;source_project_id:string;source_project_code:string;document_name:string;original_name:string;file_type:string;status:string;folder_id:string|null;folder_path:string|null;version_id:string;version_number:string;checksum:string|null;chunk_index:number;page_number:number|null;section_path:string|null;content:string;metadata:Record<string,unknown>;updated_at:Date;semantic_score:number;keyword_rank:number;hybrid_score:number;matched_by:string[];total_count:string }>(sql`
    with query as (select to_tsquery('simple', ${queryText}) value), candidates as (
      select dc.id chunk_id, d.id document_id, d.project_id source_project_id, p.code source_project_code, d.name document_name, d.original_name, d.file_type, d.status, d.folder_id, kf.path folder_path,
        dv.id version_id, dv.version_number, coalesce(dv.checksum, d.checksum) checksum, dc.chunk_index, dc.page_number, dc.section_path, dc.content, dc.metadata, d.updated_at,
        1 - (dc.embedding <=> ${vector}::vector) semantic_score,
        greatest(ts_rank_cd(dc.search_vector, query.value, 32), case when ${sql.join(substrings, sql` and `)} then 0.2 else 0 end) keyword_rank,
        ${input.mode === 'semantic' ? sql`1 - (dc.embedding <=> ${vector}::vector)` : sql`0.65 * (1 - (dc.embedding <=> ${vector}::vector)) + 0.35 * least(greatest(ts_rank_cd(dc.search_vector, query.value, 32), case when ${sql.join(substrings, sql` and `)} then 0.2 else 0 end) * 5, 1)`} hybrid_score,
        array_remove(array[case when (1 - (dc.embedding <=> ${vector}::vector)) >= ${input.minScore} then 'semantic' end, case when ${lexicalMatch} then 'keyword' end], null) matched_by
      from document_chunks dc join documents d on d.id=dc.document_id join projects p on p.id=d.project_id join document_versions dv on dv.id=dc.version_id and dv.document_id=d.id
      left join knowledge_folders kf on kf.id=d.folder_id and kf.knowledge_base_id=d.knowledge_base_id cross join query
      where d.project_id=${projectId}::uuid and dv.is_current=true and d.parse_status='completed' and d.index_status='completed' and d.ai_enabled=true and dc.embedding is not null ${filters}
        and (1 - (dc.embedding <=> ${vector}::vector)) >= ${input.minScore}
    ) select *, count(*) over()::text total_count from candidates order by hybrid_score desc, updated_at desc, chunk_id asc limit ${input.limit} offset ${input.offset}`)
  return { query: input.q, mode: input.mode, total: Number(rows.rows[0]?.total_count ?? 0), limit: input.limit, offset: input.offset, minScore: input.minScore, items: rows.rows.map(row => ({ chunkId:row.chunk_id,documentId:row.document_id,sourceProjectId:row.source_project_id,sourceProjectCode:row.source_project_code,documentName:row.document_name,originalName:row.original_name,fileType:row.file_type,status:row.status,folderId:row.folder_id,folderPath:row.folder_path,versionId:row.version_id,versionNumber:row.version_number,checksum:row.checksum,chunkIndex:row.chunk_index,pageNumber:row.page_number,sectionPath:row.section_path,snippet:snippet(row.content,input.terms),highlights:input.terms,semanticScore:Number(row.semantic_score),keywordRank:Number(row.keyword_rank),score:Number(row.hybrid_score),matchedBy:row.matched_by,metadata:row.metadata,updatedAt:row.updated_at })) }
}

async function searchKnowledgeHybrid(raw:HybridSearchInput,authorizedProjectIds:string[]){
  const input=validate(raw),scope=authorizedProjectKnowledgePredicate(authorizedProjectIds),[embedding]=await embedTexts([input.q])
  const vector=JSON.stringify(embedding),queryText=input.terms.join(' & ')
  const substrings=input.terms.map(term=>sql`lower(coalesce(dc.title, '') || ' ' || dc.content) like ${`%${escapeLike(term)}%`} escape '\\'`)
  const lexical=sql`(dc.search_vector @@ query.value or (${sql.join(substrings,sql` and `)}))`
  const rows=await db.execute<any>(sql`
    with query as(select to_tsquery('simple',${queryText}) value), candidates as(
      select dc.id chunk_id,d.id document_id,d.project_id source_project_id,p.code source_project_code,d.name document_name,d.original_name,d.file_type,d.status,d.folder_id,kf.path folder_path,
        dv.id version_id,dv.version_number,coalesce(dv.checksum,d.checksum) checksum,dc.chunk_index,dc.page_number,dc.section_path,dc.content,dc.metadata,d.updated_at,
        1-(dc.embedding <=> ${vector}::vector) semantic_score,
        greatest(ts_rank_cd(dc.search_vector,query.value,32),case when ${sql.join(substrings,sql` and `)} then 0.2 else 0 end) keyword_rank,
        0.65*(1-(dc.embedding <=> ${vector}::vector))+0.35*least(greatest(ts_rank_cd(dc.search_vector,query.value,32),case when ${sql.join(substrings,sql` and `)} then 0.2 else 0 end)*5,1) hybrid_score,
        array_remove(array[case when (1-(dc.embedding <=> ${vector}::vector))>=${input.minScore} then 'semantic' end,case when ${lexical} then 'keyword' end],null) matched_by
      from document_chunks dc
      join documents d on d.id=dc.document_id
      join knowledge_bases kb on kb.id=d.knowledge_base_id
      join projects p on p.id=d.project_id
      join document_versions dv on dv.id=dc.version_id and dv.document_id=d.id
      left join knowledge_folders kf on kf.id=d.folder_id and kf.knowledge_base_id=d.knowledge_base_id
      cross join query
      where ${scope}
        and dv.is_current=true and d.parse_status='completed' and d.index_status='completed' and d.ai_enabled=true
        and dc.embedding is not null and d.status not in('archived','obsolete')
        and (1-(dc.embedding <=> ${vector}::vector))>=${input.minScore}
    ) select *,count(*) over()::text total_count from candidates order by hybrid_score desc,updated_at desc limit ${input.limit}`)
  return{query:input.q,mode:input.mode,total:Number(rows.rows[0]?.total_count??0),limit:input.limit,offset:0,minScore:input.minScore,items:rows.rows.map((row:any)=>({chunkId:row.chunk_id,documentId:row.document_id,sourceProjectId:row.source_project_id,sourceProjectCode:row.source_project_code,documentName:row.document_name,originalName:row.original_name,fileType:row.file_type,status:row.status,folderId:row.folder_id,folderPath:row.folder_path,versionId:row.version_id,versionNumber:row.version_number,checksum:row.checksum,chunkIndex:row.chunk_index,pageNumber:row.page_number,sectionPath:row.section_path,snippet:snippet(row.content,input.terms),highlights:input.terms,semanticScore:Number(row.semantic_score),keywordRank:Number(row.keyword_rank),score:Number(row.hybrid_score),matchedBy:row.matched_by,metadata:row.metadata,updatedAt:row.updated_at}))}
}

function validate(raw: HybridSearchInput) {
  const q = typeof raw.q === 'string' ? raw.q.normalize('NFKC').trim() : ''; if(q.length<2||q.length>200||/[\u0000-\u001f]/.test(q)) throw new Error('knowledge_search_query_invalid')
  const mode:SearchMode = raw.mode === 'semantic' ? 'semantic' : raw.mode === undefined || raw.mode === 'hybrid' ? 'hybrid' : (()=>{throw new Error('knowledge_search_mode_invalid')})()
  const terms=[...new Set(q.match(/[\p{Script=Han}]|[\p{Letter}\p{Number}_-]+/gu)?.map(x=>x.toLocaleLowerCase())??[])].slice(0,20); if(!terms.length)throw new Error('knowledge_search_query_invalid')
  const folderId=typeof raw.folderId==='string'&&raw.folderId?raw.folderId:undefined;if(folderId&&!UUID_PATTERN.test(folderId))throw new Error('knowledge_folder_id_invalid')
  const fileType=typeof raw.fileType==='string'&&raw.fileType?raw.fileType.replace(/^\./,'').toLowerCase():undefined;if(fileType&&!/^[a-z0-9]{1,12}$/.test(fileType))throw new Error('knowledge_search_file_type_invalid')
  const status=typeof raw.status==='string'&&raw.status?raw.status:undefined;if(status&&!statuses.has(status))throw new Error('knowledge_search_status_invalid')
  const updatedFrom=date(raw.updatedFrom),updatedTo=date(raw.updatedTo);if(updatedFrom&&updatedTo&&updatedFrom>updatedTo)throw new Error('knowledge_search_date_range_invalid')
  const includeArchived=raw.includeArchived===true||raw.includeArchived==='true'; const limit=integer(raw.limit,20,1,50,'knowledge_search_limit_invalid'),offset=integer(raw.offset,0,0,10000,'knowledge_search_offset_invalid')
  const minScore=raw.minScore===undefined?0.45:Number(raw.minScore);if(!Number.isFinite(minScore)||minScore<0||minScore>1)throw new Error('knowledge_search_score_invalid')
  return {q,mode,terms,folderId,fileType,status,updatedFrom,updatedTo,includeArchived,limit,offset,minScore}
}
function date(value:unknown){if(value===undefined||value==='')return undefined;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(`${value}T00:00:00Z`)))throw new Error('knowledge_search_date_invalid');return value}
function integer(value:unknown,fallback:number,min:number,max:number,code:string){if(value===undefined)return fallback;const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(code);return n}
function escapeLike(value:string){return value.replace(/[\\%_]/g,m=>`\\${m}`)}
function snippet(content:string,terms:string[]){const lower=content.toLocaleLowerCase();let at=-1;for(const term of terms){const i=lower.indexOf(term);if(i>=0&&(at<0||i<at))at=i}if(at<0)at=0;const start=Math.max(0,at-90),end=Math.min(content.length,at+260);return `${start?'…':''}${content.slice(start,end).replace(/\s+/g,' ').trim()}${end<content.length?'…':''}`}

/**
 * 回填脚本：为“已归档但检索链路不完整”的知识库文档补做解析与双路索引。
 *
 * 背景缺陷：导入链路曾出现两类不完整状态——
 * 1) 只归档不解析（周会待办汇总表早期实现），文档停在 parse/index = pending；
 * 2) Wiki 索引成功即跳过 pgvector 向量化，文档状态显示 completed，但 AI 问答链路
 *    （searchAllProjectsKnowledgeHybrid，要求 embedding IS NOT NULL）搜不到内容。
 * 导入链路已统一到 document-indexing-service 修复，本脚本处理存量数据。
 *
 * 判据（满足任一即视为待回填）：
 * - parse_status / index_status 非 completed，或 ai_enabled = false；
 * - 存在分块但 embedding 为空；
 * - 已解析完成却没有任何分块。
 *
 * 安全设计：
 * - 默认 dry-run，只列出待处理文档。
 * - 仅处理 status='confirmed'；archived/obsolete 会被索引服务拒绝，主动跳过。
 * - 复用 parseAndIndexProjectDocument：Wiki 先、pgvector 后，单路失败记 warning，双路失败才报错。
 * - 单份失败不中断整体，最后汇总失败清单与回填后核对。
 *
 * 用法：
 *   node --import tsx scripts/backfill-delivery-todo-knowledge.ts                       # dry-run（默认目录）
 *   node --import tsx scripts/backfill-delivery-todo-knowledge.ts --execute             # 实际回填
 *   node --import tsx scripts/backfill-delivery-todo-knowledge.ts --folder "01-项目管理过程/01-项目实施计划" --execute
 *   node --import tsx scripts/backfill-delivery-todo-knowledge.ts --all --execute       # 全部目录
 */
import 'dotenv/config'
import pg from 'pg'
import { parseAndIndexProjectDocument } from '../apps/api/src/modules/knowledge/document-indexing-service.ts'

const DEFAULT_FOLDER = '01-项目管理过程/05-项目交付中心周会待办事项汇总表'
const args = process.argv.slice(2)
const execute = args.includes('--execute')
const allFolders = args.includes('--all')
const folderArgIndex = args.indexOf('--folder')
const folderPath = folderArgIndex >= 0 ? args[folderArgIndex + 1] : DEFAULT_FOLDER

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const folderFilter = allFolders ? '' : 'and f.path = $1'
const params = allFolders ? [] : [folderPath]

const { rows: targets } = await pool.query(
  `select d.id, d.project_id, d.name, d.parse_status, d.index_status, d.ai_enabled, p.code,
          coalesce((select count(*)::int from document_chunks dc where dc.document_id = d.id), 0) as chunks,
          coalesce((select count(*)::int from document_chunks dc where dc.document_id = d.id and dc.embedding is null), 0) as chunks_without_vector
     from documents d
     join knowledge_folders f on f.id = d.folder_id
     left join projects p on p.id = d.project_id
    where d.status = 'confirmed' ${folderFilter}
      and (d.parse_status <> 'completed' or d.index_status <> 'completed' or d.ai_enabled = false
           or exists (select 1 from document_chunks dc where dc.document_id = d.id and dc.embedding is null)
           or (d.parse_status = 'completed' and not exists (select 1 from document_chunks dc where dc.document_id = d.id)))
    order by p.code`,
  params,
)
const { rows: skipped } = await pool.query(
  `select count(*)::int n from documents d join knowledge_folders f on f.id = d.folder_id
    where d.status <> 'confirmed' ${folderFilter}`,
  params,
)

console.log(`\n模式：${execute ? 'EXECUTE' : 'DRY-RUN'}`)
console.log(`范围：${allFolders ? '全部知识目录' : folderPath}`)
console.log(`待回填：${targets.length} 份（跳过 archived/obsolete：${skipped[0]?.n ?? 0}）\n`)
for (const item of targets) {
  console.log(`  ${item.code ?? '(无项目)'} | ${item.name} | parse=${item.parse_status} index=${item.index_status} ai=${item.ai_enabled} 分块=${item.chunks} 缺向量=${item.chunks_without_vector}`)
}

if (!execute) {
  console.log('\nDRY-RUN 结束，未做任何修改。确认后加 --execute 执行回填。')
  await pool.end()
  process.exit(0)
}

const warnings: Array<{ code: string; documentId: string; stage: string; message: string }> = []
const failures: Array<{ code: string; documentId: string; message: string }> = []
let succeeded = 0

for (const item of targets) {
  const projectId = item.project_id
  if (!projectId) { failures.push({ code: item.code, documentId: item.id, message: 'document_project_id_null' }); continue }
  try {
    const result = await parseAndIndexProjectDocument(projectId, item.id)
    for (const warning of result.warnings) warnings.push({ code: item.code, documentId: item.id, stage: warning.stage, message: warning.message })
    succeeded += 1
    console.log(`  ✓ ${item.code} 回填完成（pgvector=${result.embedded ? `生成${result.embedded.generated}/复用${result.embedded.reused}` : '失败'}，wiki=${result.wiki ? `${result.wiki.pageCount}页/${result.wiki.chunkCount}块` : '失败'}）`)
  } catch (error) {
    failures.push({ code: item.code, documentId: item.id, message: error instanceof Error ? error.message : String(error) })
    console.log(`  ✗ ${item.code} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

const verify = await pool.query(
  `select count(*)::int docs,
          count(*) filter (where d.parse_status='completed' and d.index_status='completed' and d.ai_enabled) as fully_indexed,
          coalesce((select count(*)::int from document_chunks dc join documents dd on dd.id=dc.document_id join knowledge_folders ff on ff.id=dd.folder_id where dd.status='confirmed' ${folderFilter.replace(/\bd\./g, 'dd.').replace(/\bf\./g, 'ff.')}), 0) as chunks,
          coalesce((select count(*)::int from document_chunks dc join documents dd on dd.id=dc.document_id join knowledge_folders ff on ff.id=dd.folder_id where dd.status='confirmed' and dc.embedding is not null ${folderFilter.replace(/\bd\./g, 'dd.').replace(/\bf\./g, 'ff.')}), 0) as chunks_embedded
     from documents d join knowledge_folders f on f.id = d.folder_id
    where d.status = 'confirmed' ${folderFilter}`,
  params,
)

console.log(`\n回填成功 ${succeeded} 份，失败 ${failures.length} 份，索引警告 ${warnings.length} 条`)
for (const item of failures) console.log(`  ! 失败 ${item.code} ${item.documentId}: ${item.message}`)
for (const item of warnings) console.log(`  ~ 警告 ${item.code} [${item.stage}] ${item.message}`)
console.log(`\n回填后核对：${JSON.stringify(verify.rows[0])}`)
await pool.end()

/**
 * 受控清理脚本：删除“项目实施计划”历史数据（结构化数据 + 知识库 + 对象存储 + LLM Wiki 镜像）。
 *
 * 安全设计：
 * - 默认 dry-run，只统计不删除。
 * - 执行删除必须同时满足：--execute 且环境变量 PURGE_CONFIRM_TOKEN 等于 CONFIRM_TOKEN。
 * - 删除前完成三重备份：pg_dump 业务表数据、MinIO 对象下载、LLM Wiki 镜像文件复制，外加 scope.json。
 * - 范围严格限定：知识目录 01-项目管理过程/01-项目实施计划；项目编码匹配 PROJECT_CODE_PATTERN。
 * - 明确保留：OPP-* 商机数据、交付中心周会待办模块、日报/周报/月报/合同目录、表结构与配置。
 * - LLM Wiki 令牌仅从环境变量读取，脚本不打印任何密钥。
 *
 * 用法：
 *   node --import tsx scripts/purge-implementation-plans.ts                     # dry-run
 *   PURGE_CONFIRM_TOKEN=PURGE-PLAN-HISTORY node --import tsx scripts/purge-implementation-plans.ts --execute
 *   追加 --include-projects 可同时删除 12 个项目本体（会使交付待办 project_id 置空）
 *   追加 --keep-audit 仅保留审计日志；通知与 AI 会话随项目删除，但完整保存在数据库备份中
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { deleteKnowledgeObject, getKnowledgeObject, objectStorageBucket } from '../apps/api/src/infrastructure/object-storage.ts'

const CONFIRM_TOKEN = 'PURGE-PLAN-HISTORY'
const PLAN_FOLDER_PATH = '01-项目管理过程/01-项目实施计划'
const PROJECT_CODE_PATTERN = '^P-'
const WIKI_ROOT = process.env.LLM_WIKI_MIRROR_ROOT || '/home/lgsj/llm-wiki/build/source2-home/userwiki-projects'
const WIKI_API = (process.env.LLM_WIKI_API_BASE_URL?.trim() || 'http://127.0.0.1:19928').replace(/\/$/, '')
const WIKI_TOKEN = process.env.LLM_WIKI_API_TOKEN?.trim() || ''

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const includeProjects = args.includes('--include-projects')
const keepAudit = args.includes('--keep-audit')

if (execute && process.env.PURGE_CONFIRM_TOKEN !== CONFIRM_TOKEN) {
  console.error(`拒绝执行：必须设置 PURGE_CONFIRM_TOKEN=${CONFIRM_TOKEN} 才能删除数据。`)
  process.exit(2)
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const scalar = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0]
const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = path.resolve('backups', `purge-plan-${stamp}`)

async function collectScope() {
  const projects = includeProjects
    ? await rows(`select id, code, name from projects where code ~ $1 order by code`, [PROJECT_CODE_PATTERN])
    : await rows(`select distinct p.id, p.code, p.name from projects p
        where p.code ~ $1 and (
          exists (select 1 from documents d join knowledge_folders f on f.id = d.folder_id where d.project_id = p.id and f.path = $2)
          or exists (select 1 from tasks t where t.project_id = p.id)
        ) order by p.code`, [PROJECT_CODE_PATTERN, PLAN_FOLDER_PATH])
  const projectIds = projects.map(item => item.id)

  const docs = await rows(
    `select d.id, d.project_id, d.name, d.original_name, d.storage_key, d.status,
            (d.metadata->'llmWikiSummary'->>'wikiProjectId') as wiki_project_id,
            coalesce((d.metadata->'llmWikiSummary'->>'pages')::int, 0) as wiki_pages
       from documents d join knowledge_folders f on f.id = d.folder_id
      where f.path = $1 and (cardinality($2::uuid[]) = 0 or d.project_id = any($2::uuid[]))
      order by d.created_at`,
    [PLAN_FOLDER_PATH, projectIds],
  )

  const cascadeDocs = includeProjects
    ? await rows(
        `select d.id, d.project_id, d.name, d.original_name, d.storage_key, d.status,
                (d.metadata->'llmWikiSummary'->>'wikiProjectId') as wiki_project_id,
                coalesce((d.metadata->'llmWikiSummary'->>'pages')::int, 0) as wiki_pages
           from documents d
          where (d.project_id = any($1::uuid[])
                 or d.knowledge_base_id in (select id from knowledge_bases where project_id = any($1::uuid[])))
            and d.id <> all($2::uuid[])
          order by d.created_at`,
        [projectIds, docs.map(d => d.id)],
      )
    : []

  const counts = {
    documents: docs.length,
    versions: Number((await scalar(`select count(*)::int n from document_versions where document_id = any($1::uuid[])`, [docs.map(d => d.id)])).n),
    chunks: Number((await scalar(`select count(*)::int n from document_chunks where document_id = any($1::uuid[])`, [docs.map(d => d.id)])).n),
    storageObjects: new Set(docs.map(d => d.storage_key).filter(Boolean)).size,
    wikiMirrorFiles: docs.reduce((sum, d) => sum + Number(d.wiki_pages || 0), 0),
    projectsInvolved: projectIds.length,
    projectsDeleted: includeProjects ? projectIds.length : 0,
    cascadeDocuments: cascadeDocs.length,
    cascadeVersions: Number((await scalar(`select count(*)::int n from document_versions where document_id = any($1::uuid[])`, [cascadeDocs.map(d => d.id)])).n),
    cascadeChunks: Number((await scalar(`select count(*)::int n from document_chunks where document_id = any($1::uuid[])`, [cascadeDocs.map(d => d.id)])).n),
    cascadeStorageObjects: new Set(cascadeDocs.map(d => d.storage_key).filter(Boolean)).size,
    cascadeWikiPages: cascadeDocs.reduce((sum, d) => sum + Number(d.wiki_pages || 0), 0),
    knowledgeBases: includeProjects ? Number((await scalar(`select count(*)::int n from knowledge_bases where project_id = any($1::uuid[])`, [projectIds])).n) : 0,
    knowledgeFolders: includeProjects ? Number((await scalar(`select count(*)::int n from knowledge_folders where knowledge_base_id in (select id from knowledge_bases where project_id = any($1::uuid[]))`, [projectIds])).n) : 0,
    tasks: Number((await scalar(`select count(*)::int n from tasks where project_id = any($1::uuid[])`, [projectIds])).n),
    taskDependencies: Number((await scalar(`select count(*)::int n from task_dependencies where predecessor_id in (select id from tasks where project_id = any($1::uuid[])) or successor_id in (select id from tasks where project_id = any($1::uuid[]))`, [projectIds])).n),
    risks: Number((await scalar(`select count(*)::int n from risks where project_id = any($1::uuid[])`, [projectIds])).n),
    milestones: Number((await scalar(`select count(*)::int n from milestones where project_id = any($1::uuid[])`, [projectIds])).n),
    approvals: Number((await scalar(`select count(*)::int n from approval_items where project_id = any($1::uuid[])`, [projectIds])).n),
    coordination: Number((await scalar(`select count(*)::int n from coordination_items where project_id = any($1::uuid[])`, [projectIds])).n),
    phases: Number((await scalar(`select count(*)::int n from project_phases where project_id = any($1::uuid[])`, [projectIds])).n),
    importJobs: Number((await scalar(`select count(*)::int n from import_jobs where project_id = any($1::uuid[])`, [projectIds])).n),
    aiConversations: Number((await scalar(`select count(*)::int n from ai_conversations where project_id = any($1::uuid[])`, [projectIds])).n),
    aiMessages: Number((await scalar(`select count(*)::int n from ai_messages where conversation_id in (select id from ai_conversations where project_id = any($1::uuid[]))`, [projectIds])).n),
    notifications: Number((await scalar(`select count(*)::int n from notifications where project_id = any($1::uuid[])`, [projectIds])).n),
    auditLogs: keepAudit ? 0 : Number((await scalar(`select count(*)::int n from audit_logs where project_id = any($1::uuid[])`, [projectIds])).n),
  }

  const documentsTotal = Number((await scalar(`select count(*)::int n from documents`)).n)
  const preserved = {
    deliveryTodos: Number((await scalar(`select count(*)::int n from delivery_meeting_todos`)).n),
    deliveryTodoProjectLinksToNull: includeProjects
      ? Number((await scalar(`select count(*)::int n from delivery_meeting_todos where project_id = any($1::uuid[])`, [projectIds])).n)
      : 0,
    opportunityProjects: Number((await scalar(`select count(*)::int n from projects where code !~ $1`, [PROJECT_CODE_PATTERN])).n),
    documentsTotal,
    documentsDestroyed: docs.length + cascadeDocs.length,
    documentsSurviving: documentsTotal - docs.length - cascadeDocs.length,
  }

  return { projects, docs, cascadeDocs, counts, preserved }
}

/** 本次操作将真实销毁的全部文档：实施计划目录 + 删除项目本体时的级联文档。 */
function affectedDocs(scope: { docs: Array<Record<string, any>>; cascadeDocs: Array<Record<string, any>> }) {
  return [...scope.docs, ...scope.cascadeDocs]
}

function scopeSignature(scope: Awaited<ReturnType<typeof collectScope>>) {
  return JSON.stringify({
    projectIds: scope.projects.map(item => item.id),
    documentIds: scope.docs.map(item => item.id),
    cascadeDocumentIds: scope.cascadeDocs.map(item => item.id),
    counts: scope.counts,
    preserved: scope.preserved,
  })
}

async function backup(scope: Awaited<ReturnType<typeof collectScope>>) {
  await mkdir(path.join(backupDir, 'objects'), { recursive: true })
  await mkdir(path.join(backupDir, 'wiki-mirror'), { recursive: true })

  const tables = ['projects', 'project_phases', 'tasks', 'task_dependencies', 'milestones', 'risks', 'coordination_items',
    'approval_items', 'import_jobs', 'documents', 'document_versions', 'document_chunks', 'knowledge_bases',
    'knowledge_folders', 'ai_conversations', 'ai_messages', 'ai_message_feedback', 'ai_citations', 'notifications',
    'audit_logs', 'delivery_meeting_todo_imports', 'delivery_meeting_todos', 'delivery_meeting_todo_analyses']
  const dumpFile = path.join(backupDir, 'db-business-data.sql')
  execFileSync('pg_dump', [String(process.env.DATABASE_URL), '--data-only', '--column-inserts', '--no-owner',
    ...tables.flatMap(table => ['--table', table]), '--file', dumpFile], { stdio: ['ignore', 'ignore', 'inherit'] })

  await writeFile(path.join(backupDir, 'scope.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), mode: execute ? 'execute' : 'dry-run', includeProjects, keepAudit,
    planFolderPath: PLAN_FOLDER_PATH, projectCodePattern: PROJECT_CODE_PATTERN,
    projects: scope.projects, counts: scope.counts, preserved: scope.preserved,
    documents: scope.docs.map(d => ({ id: d.id, projectId: d.project_id, name: d.name, originalName: d.original_name, storageKey: d.storage_key, status: d.status, wikiProjectId: d.wiki_project_id, wikiPages: d.wiki_pages })),
    cascadeDocuments: scope.cascadeDocs.map(d => ({ id: d.id, projectId: d.project_id, name: d.name, originalName: d.original_name, storageKey: d.storage_key, status: d.status, wikiProjectId: d.wiki_project_id, wikiPages: d.wiki_pages })),
  }, null, 2), 'utf8')

  const objectFailures: string[] = []
  let objectsSaved = 0
  for (const doc of affectedDocs(scope)) {
    if (!doc.storage_key) continue
    try {
      const object = await getKnowledgeObject(doc.storage_key)
      const body = object.body ? Buffer.from(await object.body.transformToByteArray()) : Buffer.alloc(0)
      await writeFile(path.join(backupDir, 'objects', `${doc.id}.bin`), body)
      objectsSaved += 1
    } catch (error) { objectFailures.push(`${doc.id}: ${error instanceof Error ? error.message : 'object_backup_failed'}`) }
  }

  const mirrorFailures: string[] = []
  let mirrorSaved = 0
  for (const doc of affectedDocs(scope)) {
    if (!doc.wiki_project_id) continue
    for (let page = 1; page <= Number(doc.wiki_pages || 0); page += 1) {
      const source = path.join(WIKI_ROOT, doc.wiki_project_id, 'wiki/knowledge-mirror/documents', `${doc.id}-${page}.md`)
      try { await copyFile(source, path.join(backupDir, 'wiki-mirror', `${doc.id}-${page}.md`)); mirrorSaved += 1 }
      catch (error) { mirrorFailures.push(`${doc.id}-${page}: ${error instanceof Error ? error.message : 'mirror_backup_failed'}`) }
    }
  }

  const dumpStats = await stat(dumpFile)
  const expectedObjects = new Set(affectedDocs(scope).map(d => d.storage_key).filter(Boolean)).size
  const expectedMirrors = affectedDocs(scope).reduce((sum, doc) => sum + Number(doc.wiki_pages || 0), 0)
  if (dumpStats.size <= 0 || objectFailures.length || mirrorFailures.length || objectsSaved !== expectedObjects || mirrorSaved !== expectedMirrors) {
    throw new Error(`backup_incomplete:dumpBytes=${dumpStats.size};objects=${objectsSaved}/${expectedObjects};mirrors=${mirrorSaved}/${expectedMirrors};objectFailures=${objectFailures.join('|')};mirrorFailures=${mirrorFailures.join('|')}`)
  }

  return { dumpFile, dumpBytes: dumpStats.size, objectsSaved, mirrorSaved }
}

async function purgeDatabase(scope: Awaited<ReturnType<typeof collectScope>>) {
  const projectIds = scope.projects.map(p => p.id)
  const documentIds = [...scope.docs.map(d => d.id), ...scope.cascadeDocs.map(d => d.id)]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`insert into audit_logs (id, project_id, entity_type, entity_id, action, actor_name, changes)
      values (gen_random_uuid(), null, 'purge', null, 'implementation_plan_purge', 'maintenance-script', $1::jsonb)`,
      [JSON.stringify({ mode: 'execute', includeProjects, keepAudit, projectCount: projectIds.length, documentCount: documentIds.length, counts: scope.counts, backupDir })])
    await client.query(`delete from document_chunks where document_id = any($1::uuid[])`, [documentIds])
    await client.query(`delete from document_versions where document_id = any($1::uuid[])`, [documentIds])
    await client.query(`delete from documents where id = any($1::uuid[])`, [documentIds])
    await client.query(`delete from ai_citations where message_id in (select id from ai_messages where conversation_id in (select id from ai_conversations where project_id = any($1::uuid[])))`, [projectIds])
    await client.query(`delete from ai_message_feedback where message_id in (select id from ai_messages where conversation_id in (select id from ai_conversations where project_id = any($1::uuid[])))`, [projectIds])
    await client.query(`delete from ai_messages where conversation_id in (select id from ai_conversations where project_id = any($1::uuid[]))`, [projectIds])
    await client.query(`delete from ai_conversations where project_id = any($1::uuid[])`, [projectIds])
    await client.query(`delete from task_dependencies where predecessor_id in (select id from tasks where project_id = any($1::uuid[])) or successor_id in (select id from tasks where project_id = any($1::uuid[]))`, [projectIds])
    for (const table of ['tasks', 'risks', 'milestones', 'approval_items', 'coordination_items', 'project_phases', 'import_jobs', 'notifications']) {
      await client.query(`delete from ${table} where project_id = any($1::uuid[])`, [projectIds])
    }
    if (!keepAudit) await client.query(`delete from audit_logs where project_id = any($1::uuid[])`, [projectIds])
    if (includeProjects) {
      await client.query(`delete from knowledge_folders where knowledge_base_id in (select id from knowledge_bases where project_id = any($1::uuid[]))`, [projectIds])
      await client.query(`delete from knowledge_bases where project_id = any($1::uuid[])`, [projectIds])
      await client.query(`delete from projects where id = any($1::uuid[])`, [projectIds])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function purgeObjectStorage(scope: Awaited<ReturnType<typeof collectScope>>) {
  const failures: string[] = []
  let deleted = 0
  for (const key of new Set(affectedDocs(scope).map(d => d.storage_key).filter(Boolean))) {
    try { await deleteKnowledgeObject(key); deleted += 1 } catch (error) { failures.push(`${key}: ${error instanceof Error ? error.message : 'delete_failed'}`) }
  }
  return { deleted, failures, bucket: objectStorageBucket() }
}

async function purgeLlmWiki(scope: Awaited<ReturnType<typeof collectScope>>) {
  const failures: string[] = []
  let indexDeleted = 0, filesDeleted = 0
  for (const doc of affectedDocs(scope)) {
    if (!doc.wiki_project_id) continue
    for (let page = 1; page <= Number(doc.wiki_pages || 0); page += 1) {
      const relative = `wiki/knowledge-mirror/documents/${doc.id}-${page}.md`
      if (WIKI_TOKEN) {
        try {
          const response = await fetch(`${WIKI_API}/api/v1/projects/${encodeURIComponent(doc.wiki_project_id)}/pages/index`, {
            method: 'DELETE', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${WIKI_TOKEN}` },
            body: JSON.stringify({ path: relative }),
          })
          if (response.ok || response.status === 404) indexDeleted += 1
          else failures.push(`wiki_index ${doc.id}-${page}: HTTP ${response.status}`)
        } catch (error) { failures.push(`wiki_index ${doc.id}-${page}: ${error instanceof Error ? error.message : 'request_failed'}`) }
      } else failures.push(`wiki_index ${doc.id}-${page}: llm_wiki_token_missing`)
      const file = path.join(WIKI_ROOT, doc.wiki_project_id, relative)
      try { const { unlink } = await import('node:fs/promises'); await unlink(file); filesDeleted += 1 } catch { /* 文件不存在视为已清理 */ }
    }
  }
  return { indexDeleted, filesDeleted, failures, tokenConfigured: Boolean(WIKI_TOKEN) }
}

const scope = await collectScope()
console.log(`\n模式：${execute ? 'EXECUTE（将真实删除）' : 'DRY-RUN（仅统计，不删除）'}`)
console.log(`范围：知识目录「${PLAN_FOLDER_PATH}」；项目编码匹配 /${PROJECT_CODE_PATTERN}/；includeProjects=${includeProjects}；keepAudit=${keepAudit}\n`)
console.log('将删除：')
for (const [key, value] of Object.entries(scope.counts)) console.log(`  ${key.padEnd(18)} ${value}`)
console.log('\n明确保留：')
for (const [key, value] of Object.entries(scope.preserved)) console.log(`  ${key.padEnd(34)} ${value}`)
console.log(`\n涉及项目：${scope.projects.map(p => `${p.code}(${p.name})`).join('、') || '无'}`)
if (includeProjects) {
  const codeById = new Map(scope.projects.map(p => [p.id, p.code]))
  console.log(`\n级联销毁的知识库文档（不在实施计划目录内，但随项目/知识库一并删除）：${scope.cascadeDocs.length} 份`)
  for (const doc of scope.cascadeDocs) console.log(`  - ${codeById.get(doc.project_id) ?? doc.project_id ?? '(无项目)'} | ${doc.status} | ${doc.name}`)
}
if (scope.preserved.deliveryTodoProjectLinksToNull) {
  console.log(`\n警告：--include-projects 会使 ${scope.preserved.deliveryTodoProjectLinksToNull} 条交付周会待办的 project_id 被置空（外键 onDelete=set null），`)
  console.log('      待办内容本身保留，但需要重新导入汇总表才能重新关联到新项目。')
}

if (!execute) {
  console.log('\nDRY-RUN 结束，未做任何修改。确认无误后加 --execute 并设置 PURGE_CONFIRM_TOKEN 执行。')
  await pool.end()
  process.exit(0)
}

if (!WIKI_TOKEN && affectedDocs(scope).some(doc => Number(doc.wiki_pages || 0) > 0)) throw new Error('llm_wiki_token_missing_before_backup')
const saved = await backup(scope)
console.log(`\n备份完成：${saved.dumpFile}（${saved.dumpBytes} bytes）`)
console.log(`  对象存储已下载 ${saved.objectsSaved} 个；Wiki 镜像已复制 ${saved.mirrorSaved} 个；scope.json 已写入 ${backupDir}`)

const scopeAfterBackup = await collectScope()
if (scopeSignature(scopeAfterBackup) !== scopeSignature(scope)) throw new Error('scope_changed_after_backup')
console.log('动态范围复核通过：备份前后项目、文档、计数完全一致。')

await purgeDatabase(scope)
console.log('数据库清理完成（事务提交）。')

const storage = await purgeObjectStorage(scope)
console.log(`对象存储清理：删除 ${storage.deleted} 个对象（bucket=${storage.bucket}），失败 ${storage.failures.length}`)
for (const item of storage.failures) console.log(`  ! ${item}`)

const wiki = await purgeLlmWiki(scope)
console.log(`LLM Wiki 清理：索引删除 ${wiki.indexDeleted} 页，镜像文件删除 ${wiki.filesDeleted} 个，令牌已配置=${wiki.tokenConfigured}，失败 ${wiki.failures.length}`)
for (const item of wiki.failures.slice(0, 20)) console.log(`  ! ${item}`)

const after = {
  documents: Number((await scalar(`select count(*)::int n from documents d join knowledge_folders f on f.id=d.folder_id where f.path=$1`, [PLAN_FOLDER_PATH])).n),
  projects: Number((await scalar(`select count(*)::int n from projects where code ~ $1`, [PROJECT_CODE_PATTERN])).n),
  projectsTotal: Number((await scalar(`select count(*)::int n from projects`)).n),
  tasks: Number((await scalar(`select count(*)::int n from tasks`)).n),
  documentsTotal: Number((await scalar(`select count(*)::int n from documents`)).n),
  knowledgeBases: Number((await scalar(`select count(*)::int n from knowledge_bases`)).n),
  deliveryTodos: Number((await scalar(`select count(*)::int n from delivery_meeting_todos`)).n),
  deliveryTodosLinked: Number((await scalar(`select count(*)::int n from delivery_meeting_todos where project_id is not null`)).n),
}
console.log(`\n清理后核对：${JSON.stringify(after)}`)
console.log(`备份目录：${backupDir}`)
await pool.end()

import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { Readable } from 'node:stream'
import { DeepSeekHarnessClient } from './ai/deepseek-harness.ts'
import { AgronHarnessClient, AgronMuxClient } from './ai/agron-harness.ts'
import { eq } from 'drizzle-orm'
import { db, pool } from './db/client.ts'
import { projects } from './db/schema.ts'
import { checkRedis, redis } from './infrastructure/redis.ts'
import { checkObjectStorage, ensureObjectStorageBucket } from './infrastructure/object-storage.ts'
import { getPortfolioSummary } from './modules/projects/project-overview.ts'
import { getProjectOverview } from './modules/projects/project-details.ts'
import { createProjectPhase, deleteProjectPhase, listProjectPhases, reorderProjectPhases, updateProjectPhase } from './modules/projects/phase-service.ts'
import { listProjectActivities, listProjectActivitySummary, listProjectNotifications, markProjectNotificationRead } from './modules/audit/audit-log.ts'
import { createProject, getProject, listProjects, updateProject } from './modules/projects/project-service.ts'
import { createProjectTask, getProjectTask, listProjectTasks, updateProjectTask } from './modules/tasks/task-service.ts'
import { createDependency, deleteDependency, listTaskDependencies } from './modules/tasks/dependency-service.ts'
import { createProjectMilestone, getProjectMilestone, listProjectMilestones, updateProjectMilestone } from './modules/milestones/milestone-service.ts'
import { createProjectRisk, getProjectRisk, listProjectRisks, updateProjectRisk } from './modules/risks/risk-service.ts'
import { createProjectCoordinationItem, getProjectCoordinationItem, listProjectCoordinationItems, updateProjectCoordinationItem } from './modules/coordination/coordination-service.ts'
import { createProjectApproval, getProjectApproval, listProjectApprovals, updateProjectApproval } from './modules/approvals/approval-service.ts'
import { createProjectKnowledgeDocument, createProjectProcessDocument, createProjectKnowledgeDocumentVersion, createProjectKnowledgeFolder, deleteProjectKnowledgeFolder, getAllProjectsKnowledgeWorkspace, getProjectKnowledgeDocument, getProjectKnowledgeDocumentDownload, getProjectKnowledgeWorkspace, listProjectKnowledgeDocuments, listProjectKnowledgeDocumentVersions, listProjectKnowledgeFolders, updateProjectKnowledgeDocument, updateProjectKnowledgeFolder, type KnowledgeDocumentUpload } from './modules/knowledge/knowledge-service.ts'
import { replaceProjectDocumentVersionChunks, searchProjectKnowledgeVectors } from './modules/knowledge/vector-store-service.ts'
import { listProjectDocumentVersionChunks, parseProjectKnowledgeDocumentVersion } from './modules/knowledge/document-processing-service.ts'
import { searchProjectKnowledgeContent, type KnowledgeContentSearchFilters } from './modules/knowledge/full-text-search-service.ts'
import { embedProjectDocumentVersion } from './modules/knowledge/embedding-service.ts'
import { parseAndIndexProjectDocument } from './modules/knowledge/document-indexing-service.ts'
import { indexProjectDocumentInLlmWiki } from './modules/knowledge/llm-wiki-index-service.ts'
import { searchAllProjectsKnowledgeHybrid, searchProjectKnowledgeHybrid, type HybridSearchInput } from './modules/knowledge/hybrid-search-service.ts'
import { checkEmbeddingProvider } from './infrastructure/embedding-client.ts'
import { isLlmWikiConfigured, llmWikiHealth, llmWikiPrimarySearch } from './infrastructure/llm-wiki-client.ts'
import { bindHarnessSession, createProjectAiConversation, deleteProjectAiConversation, getProjectAiConversation, listProjectAiConversations, listProjectAiMessages, updateProjectAiConversation } from './modules/ai/ai-conversation-service.ts'
import { HarnessError } from './ai/deepseek-harness.ts'
import { answerProjectQuestion } from './modules/ai/rag-answer-service.ts'
import { HarnessMuxClient } from './ai/harness-mux.ts'
import { AiStreamService } from './modules/ai/ai-stream-service.ts'
import { getProjectAiMessageFeedback, setProjectAiMessageFeedback } from './modules/ai/ai-feedback-service.ts'
import { registerProjectDocumentRoutes } from './modules/ai/project-document-routes.ts'
import { getProjectAiScopes } from './modules/ai/ai-scope-service.ts'
import { createImportJob, executeImport, executeWeeklyBatchImport, listImportJobs, previewImport, previewWeeklyBatchImport } from './modules/imports/import-service.ts'
import { confirmImplementationPlanChanges, latestImplementationPlanChangeMarkers, listImplementationPlanBatchChanges, listImplementationPlanEntityChanges, previewImplementationPlanChanges } from './modules/imports/project-import-change-service.ts'
import { registerLegacyImportExecuteRoute } from './modules/imports/legacy-import-routes.ts'
import { requireImportChangeTrackingEnabled } from './modules/imports/import-change-feature.ts'
import { getProjectWeeklyReport } from './modules/projects/weekly-report-service.ts'
import { getWeeklyProgressSummary } from './modules/projects/weekly-progress-summary.ts'
import { getLatestWeeklyCompletion } from './modules/projects/weekly-completion-service.ts'
import { getProjectChangeAnalysis } from './modules/projects/project-change-analysis.ts'
import { getProjectHealthSummary } from './modules/projects/project-health-summary.ts'
import { executeDeliveryMeetingTodos, listDeliveryMeetingTodos, previewDeliveryMeetingTodos } from './modules/imports/delivery-meeting-todo-service.ts'
import { getDeliveryMeetingTodoDashboard, warmDeliveryMeetingTodoAnalysis } from './modules/imports/delivery-meeting-todo-dashboard-service.ts'
import { addPersonalMemory, ensurePersonalKnowledgeWorkspace, generatePersonalReport, listPersonalMemories, listPersonalReports, searchPersonalKnowledge, validateAccountId } from './modules/personal/personal-service.ts'
import { registerAuthGuard } from './auth.ts'

const app = Fastify({ logger: true })
const PERSONAL_ACCOUNTS = (process.env.PERSONAL_KNOWLEDGE_ACCOUNT_IDS ?? 'person-01,person-02,person-04,person-05,person-06,person-07').split(',').map(value => value.trim()).filter(Boolean)
const isUniqueViolation = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505')
const allowedOrigins = (process.env.WEB_ALLOWED_ORIGINS ?? 'http://127.0.0.1:3200,http://localhost:3200').split(',').map(value => value.trim()).filter(Boolean)
await app.register(cors, { origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)) })
const maxUploadBytes = Number(process.env.S3_MAX_OBJECT_BYTES ?? 20 * 1024 * 1024)
if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) throw new Error('S3_MAX_OBJECT_BYTES must be a positive safe integer')
await app.register(multipart, { limits: { files: 50, fileSize: maxUploadBytes, fields: 8, parts: 60 } })
registerAuthGuard(app, {
  appId: 'project',
  portalUrl: process.env.ZH_PORTAL_URL ?? 'http://192.168.8.103:3300',
  serviceToken: process.env.ZH_SERVICE_TOKEN,
})
const legacyHarness = new DeepSeekHarnessClient({
  baseUrl: process.env.DSH_BASE_URL ?? 'http://127.0.0.1:3080',
  provider: process.env.DSH_PROVIDER,
  model: process.env.DSH_MODEL,
})
const agron = process.env.ZHIHUI_AI_PROVIDER === 'agron-local'
  ? new AgronHarnessClient({ baseUrl: process.env.ZHIHUI_AI_BASE_URL ?? 'http://127.0.0.1:18092/v1', apiKeyFile: process.env.ZHIHUI_AI_API_KEY_FILE ?? '', maxTokens: 2048, answerTimeoutMs: Number(process.env.DSH_ANSWER_TIMEOUT_MS ?? 240000) })
  : undefined
const harness = agron ?? legacyHarness
const harnessMux = agron ? new AgronMuxClient(agron) : new HarnessMuxClient()
const aiStreams = new AiStreamService(harness, harnessMux)
harnessMux.start()

app.get('/health', async () => ({ ok: true, service: 'project-manager-api' }))
app.get<{ Params: { accountId: string } }>('/api/accounts/:accountId/knowledge', async (request, reply) => { try { return await ensurePersonalKnowledgeWorkspace(request.params.accountId) } catch (error) { const code = error instanceof Error ? error.message : 'personal_knowledge_failed'; return reply.code(code === 'personal_account_id_invalid' ? 400 : 500).send({ error: code }) } })
app.get<{ Params: { accountId: string } }>('/api/accounts/:accountId/memories', async (request, reply) => { try { return await listPersonalMemories(request.params.accountId) } catch (error) { const code = error instanceof Error ? error.message : 'personal_memory_failed'; return reply.code(code === 'personal_account_id_invalid' ? 400 : 500).send({ error: code }) } })
app.post<{ Params: { accountId: string }; Body: { content: string; category?: string; sourceType?: string; sourceId?: string; occurredAt?: string; importance?: number } }>('/api/accounts/:accountId/memories', async (request, reply) => { try { return reply.code(201).send(await addPersonalMemory(request.params.accountId, request.body)) } catch (error) { const code = error instanceof Error ? error.message : 'personal_memory_failed'; return reply.code(code === 'personal_account_id_invalid' || code === 'personal_memory_content_invalid' ? 400 : 500).send({ error: code }) } })
app.get<{ Params: { accountId: string }; Querystring: { period?: 'daily'|'weekly'|'monthly' } }>('/api/accounts/:accountId/reports', async request => listPersonalReports(request.params.accountId, request.query.period))
app.get<{ Params: { accountId: string }; Querystring: { q: string; limit?: string } }>('/api/accounts/:accountId/personal-knowledge/search', async (request, reply) => { try { return await searchPersonalKnowledge(request.params.accountId, request.query.q, Number(request.query.limit ?? 20)) } catch (error) { const code = error instanceof Error ? error.message : 'personal_knowledge_search_failed'; return reply.code(code.includes('invalid') ? 400 : 500).send({ error: code }) } })
app.post<{ Params: { accountId: string; period: 'daily'|'weekly'|'monthly' }; Body: { date?: string } }>('/api/accounts/:accountId/reports/:period', async (request, reply) => { try { if (!['daily','weekly','monthly'].includes(request.params.period)) return reply.code(400).send({ error: 'personal_report_period_invalid' }); return reply.code(201).send(await generatePersonalReport(request.params.accountId, request.params.period, request.body?.date)) } catch (error) { const code = error instanceof Error ? error.message : 'personal_report_failed'; return reply.code(code.includes('invalid') ? 400 : 500).send({ error: code }) } })
app.get('/health/embedding', async (_request, reply) => { try { return await checkEmbeddingProvider() } catch (error) { return reply.code(503).send({ ok: false, error: error instanceof Error ? error.message : 'knowledge_embedding_provider_failed' }) } })
app.get('/health/llm-wiki', async (_request, reply) => { try { const health = await llmWikiHealth(); return { ...health, configured: isLlmWikiConfigured() } } catch (error) { return reply.code(503).send({ ok: false, configured: isLlmWikiConfigured(), error: error instanceof Error ? error.message : 'llm_wiki_unavailable' }) } })
app.get('/health/dependencies', async (_request, reply) => {
  const [database, cache, objectStorage, dsh, llmWiki] = await Promise.allSettled([
    pool.query('select 1'), checkRedis(), checkObjectStorage(), harness.health(), llmWikiHealth(),
  ])
  const result = {
    database: database.status === 'fulfilled',
    redis: cache.status === 'fulfilled' && cache.value === true,
    objectStorage: objectStorage.status === 'fulfilled' && objectStorage.value === true,
    dsh: dsh.status === 'fulfilled' && dsh.value.ok === true,
    llmWiki: llmWiki.status === 'fulfilled' && llmWiki.value.ok === true && isLlmWikiConfigured(),
  }
  return reply.code(Object.values(result).every(Boolean) ? 200 : 503).send({ ok: Object.values(result).every(Boolean), ...result })
})
app.get('/health/harness', async (_request, reply) => { try { return await harness.health() } catch (error) { return sendAiError(reply, error, 'harness_health_failed') } })
app.get<{ Querystring: { includeArchived?: string } }>('/api/projects', async request => listProjects(request.query.includeArchived === 'true'))
app.get<{ Querystring: { includeArchived?: string } }>('/api/projects/summary', async request => getPortfolioSummary(new Date(), request.query.includeArchived === 'true'))
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/weekly-progress-summary', async (request, reply) => { const result = await getWeeklyProgressSummary(request.params.projectId, legacyHarness); return result ?? reply.code(404).send({ error: 'project_not_found' }) })
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/weekly-completion', async (request, reply) => { const result = await getLatestWeeklyCompletion(request.params.projectId, legacyHarness); return result ?? reply.code(404).send({ error: 'project_not_found' }) })
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/change-analysis', async (request, reply) => { const result = await getProjectChangeAnalysis(request.params.projectId, harness); return result ?? reply.code(404).send({ error: 'project_not_found' }) })
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/health-summary', async (request, reply) => { const result = await getProjectHealthSummary(request.params.projectId, harness); return result ?? reply.code(404).send({ error: 'project_not_found' }) })
app.post<{ Body: Record<string, unknown> }>('/api/projects', async (request, reply) => {
  try { return reply.code(201).send(await createProject(request.body as never)) }
  catch (error) { const code = isUniqueViolation(error) ? 'project_code_duplicate' : error instanceof Error ? error.message : 'project_create_failed'; return reply.code(code === 'project_code_duplicate' ? 409 : 400).send({ error: code }) }
})
app.patch<{ Params: { projectId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId', async (request, reply) => {
  try { const project = await updateProject(request.params.projectId, request.body as never); if (!project) return reply.code(404).send({ error: 'project_not_found' }); return project }
  catch (error) { const code = isUniqueViolation(error) ? 'project_code_duplicate' : error instanceof Error ? error.message : 'project_update_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'project_code_duplicate' ? 409 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string }; Querystring: { from?: string; to?: string } }>('/api/projects/:projectId/reports/weekly', async (request, reply) => {
  try {
    const report = await getProjectWeeklyReport(request.params.projectId, request.query)
    if (!report) return reply.code(404).send({ error: 'project_not_found' })
    return report
  } catch (error) {
    const code = error instanceof Error ? error.message : 'weekly_report_failed'
    return reply.code(code === 'weekly_report_date_range_invalid' ? 400 : 500).send({ error: code })
  }
})
app.get<{ Params: { projectId: string }; Querystring: { entityType?: string; range?: string } }>('/api/projects/:projectId/activities/summary', async (request, reply) => {
  const now = new Date()
  const from = request.query.range === 'week' ? startOfWeek(now) : request.query.range === '30d' ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) : undefined
  const allowedActivityTypes = new Set(['project','phase','task','milestone','risk','coordination','approval','folder','document'])
  if (request.query.entityType && request.query.entityType !== 'all' && !allowedActivityTypes.has(request.query.entityType)) return reply.code(400).send({ error: 'activity_entity_type_invalid' })
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, request.params.projectId)).limit(1)
  if (!project) return reply.code(404).send({ error: 'project_not_found' })
  return listProjectActivitySummary(request.params.projectId, { entityType: request.query.entityType && request.query.entityType !== 'all' ? request.query.entityType as never : undefined, from, to: now })
})
app.get<{ Params: { projectId: string }; Querystring: { entityType?: string; range?: string; limit?: string; offset?: string } }>('/api/projects/:projectId/activities', async (request, reply) => {
  const now = new Date()
  const from = request.query.range === 'week' ? startOfWeek(now) : request.query.range === '30d' ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) : undefined
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, request.params.projectId)).limit(1)
  if (!project) return reply.code(404).send({ error: 'project_not_found' })
  const allowedActivityTypes = new Set(['project','phase','task','milestone','risk','coordination','approval','folder','document'])
  if (request.query.entityType && request.query.entityType !== 'all' && !allowedActivityTypes.has(request.query.entityType)) return reply.code(400).send({ error: 'activity_entity_type_invalid' })
  const limit = request.query.limit === undefined ? 20 : Number(request.query.limit)
  const offset = request.query.offset === undefined ? 0 : Number(request.query.offset)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return reply.code(400).send({ error: 'activity_pagination_invalid' })
  return listProjectActivities(request.params.projectId, { entityType: request.query.entityType && request.query.entityType !== 'all' ? request.query.entityType as never : undefined, from, to: now, limit, offset })
})
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/notifications', async (request, reply) => {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, request.params.projectId)).limit(1)
  if (!project) return reply.code(404).send({ error: 'project_not_found' })
  return listProjectNotifications(request.params.projectId)
})
app.post<{ Params: { projectId: string; id: string } }>('/api/projects/:projectId/notifications/:id/read', async (request, reply) => {
  const marked = await markProjectNotificationRead(request.params.projectId, request.params.id)
  if (!marked) return reply.code(404).send({ error: 'notification_not_found' })
  return { success: true }
})
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/overview', async (request, reply) => {
  const overview = await getProjectOverview(request.params.projectId)
  if (!overview) return reply.code(404).send({ error: 'project_not_found' })
  return overview
})
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
  const project = await getProject(request.params.projectId)
  if (!project) return reply.code(404).send({ error: 'project_not_found' })
  return project
})
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/imports', async (request, reply) => {
  try { return await listImportJobs(request.params.projectId) }
  catch (error) { const code = error instanceof Error ? error.message : 'import_list_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.post<{ Params: { projectId: string }; Body: { kind?: unknown; sourceName?: unknown } }>('/api/projects/:projectId/imports', async (request, reply) => {
  try {
    const { kind, sourceName } = request.body ?? {}
    if (typeof kind !== 'string' || typeof sourceName !== 'string') return reply.code(400).send({ error: 'import_body_invalid' })
    return reply.code(201).send(await createImportJob(request.params.projectId, kind, sourceName))
  } catch (error) { const code = error instanceof Error ? error.message : 'import_create_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/imports/preview', async (request, reply) => {
  try {
    const upload = await readImportUpload(request)
    return await previewImport(request.params.projectId, upload.kind, upload.fileName, upload.body)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'import_preview_failed'
    return reply.code(code === 'project_not_found' ? 404 : code === 'import_format_unsupported' ? 415 : 400).send({ error: code })
  }
})
registerLegacyImportExecuteRoute(app,{readUpload:readImportUpload,execute:executeImport})
app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/imports/implementation-plan/preview', async (request, reply) => {
  try {
    requireImportChangeTrackingEnabled()
    const upload = await readImportUpload(request)
    if (upload.kind !== 'tasks') return reply.code(400).send({ error: 'import_kind_unsupported' })
    return reply.code(201).send(await previewImplementationPlanChanges(request.params.projectId, upload.fileName, upload.body, importChangeActor(request)))
  } catch (error) { return sendProjectImportChangeError(reply, error, 'import_preview_failed') }
})
app.post<{ Params: { projectId: string; batchId: string }; Body: { previewFingerprint?: string; baseBatchId?: string | null; confirmCriticalChanges?: boolean } }>('/api/projects/:projectId/imports/implementation-plan/:batchId/confirm', async (request, reply) => {
  try {
    requireImportChangeTrackingEnabled()
    return reply.code(201).send(await confirmImplementationPlanChanges(request.params.projectId, request.params.batchId, {
      ...request.body,
      ...importChangeActor(request),
    }))
  } catch (error) { return sendProjectImportChangeError(reply, error, 'import_confirm_failed') }
})
app.get<{ Params: { projectId: string; batchId: string }; Querystring: { entityKey?: string; severity?: string; changeType?: string; page?: string } }>('/api/projects/:projectId/imports/implementation-plan/:batchId/changes', async (request, reply) => {
  try { return await listImplementationPlanBatchChanges(request.params.projectId, request.params.batchId, request.query) }
  catch (error) { return sendProjectImportChangeError(reply, error, 'import_changes_failed') }
})
app.get<{ Params: { projectId: string; entityId: string }; Querystring: { limit?: string } }>('/api/projects/:projectId/imports/implementation-plan/entities/:entityId/changes', async (request, reply) => {
  try { return await listImplementationPlanEntityChanges(request.params.projectId, request.params.entityId, Number(request.query.limit) || 20) }
  catch (error) { return sendProjectImportChangeError(reply, error, 'entity_changes_failed') }
})
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/imports/implementation-plan/latest-markers', async (request, reply) => {
  try {
    if (!await getProject(request.params.projectId)) return reply.code(404).send({ error: 'project_not_found' })
    return await latestImplementationPlanChangeMarkers(request.params.projectId)
  } catch (error) { return sendProjectImportChangeError(reply, error, 'import_markers_failed') }
})
app.post('/api/imports/delivery-meeting-todos/preview', async (request, reply) => {
  try { const upload = await readImportUpload(request); return await previewDeliveryMeetingTodos(upload.fileName, upload.body) }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'meeting_todo_preview_failed' }) }
})
app.post('/api/imports/delivery-meeting-todos', async (request, reply) => {
  try { const upload = await readImportUpload(request); const result=await executeDeliveryMeetingTodos(upload.fileName, upload.body);void warmDeliveryMeetingTodoAnalysis(result.id,harness).catch(error=>app.log.warn({error},'delivery meeting todo analysis warmup failed'));return reply.code(201).send(result) }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'meeting_todo_import_failed' }) }
})
app.get<{ Querystring: { projectId?: string } }>('/api/imports/delivery-meeting-todos', async request => listDeliveryMeetingTodos(request.query.projectId))
app.get<{ Querystring:{batchId?:string} }>('/api/delivery-meeting-todos/dashboard',async request=>getDeliveryMeetingTodoDashboard(request.query.batchId,harness))
app.post<{ Querystring:{batchId?:string} }>('/api/delivery-meeting-todos/analyze',async request=>getDeliveryMeetingTodoDashboard(request.query.batchId,harness,true))
app.post('/api/imports/weekly-batch/preview', async (request, reply) => {
  try { const files: Array<{ fileName: string; body: Buffer }> = []; for await (const part of request.parts()) if (part.type === 'file') { const chunks: Buffer[] = []; for await (const chunk of part.file) chunks.push(Buffer.from(chunk)); files.push({ fileName: part.filename, body: Buffer.concat(chunks) }) }; if (!files.length) return reply.code(400).send({ error: 'import_file_required' }); return previewWeeklyBatchImport(files) }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'import_batch_preview_failed' }) }
})
app.post('/api/imports/weekly-batch', async (request, reply) => {
  try {
    let weekStart = ''; let weekEnd = ''; let bindings: Record<string, string> = {}; let autoCreate = true; let confirmNameChanges = false; const files: Array<{ fileName: string; body: Buffer }> = []
    for await (const part of request.parts()) {
      if (part.type === 'file') { const chunks: Buffer[] = []; for await (const chunk of part.file) chunks.push(Buffer.from(chunk)); files.push({ fileName: part.filename, body: Buffer.concat(chunks) }) }
      else if (part.fieldname === 'weekStart') weekStart = String(part.value)
      else if (part.fieldname === 'weekEnd') weekEnd = String(part.value)
      else if (part.fieldname === 'bindings') bindings = JSON.parse(String(part.value))
      else if (part.fieldname === 'autoCreate') autoCreate = String(part.value) === 'true'
      else if (part.fieldname === 'confirmNameChanges') confirmNameChanges = String(part.value) === 'true'
    }
    if (!files.length) return reply.code(400).send({ error: 'import_file_required' })
    return reply.code(201).send(await executeWeeklyBatchImport(files, weekStart, weekEnd, bindings, autoCreate, confirmNameChanges))
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'import_batch_failed' }) }
})
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/phases', async (request, reply) => {
  try { return await listProjectPhases(request.params.projectId) }
  catch (error) { const code = error instanceof Error ? error.message : 'phase_list_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.post<{ Params: { projectId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/phases', async (request, reply) => {
  try { return reply.code(201).send(await createProjectPhase(request.params.projectId, request.body as never)) }
  catch (error) { const code = error instanceof Error ? error.message : 'phase_create_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'phase_duplicate_code' ? 409 : 400).send({ error: code }) }
})
app.patch<{ Params: { projectId: string; phaseId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/phases/:phaseId', async (request, reply) => {
  try { const phase = await updateProjectPhase(request.params.projectId, request.params.phaseId, request.body as never); if (!phase) return reply.code(404).send({ error: 'phase_not_found' }); return phase }
  catch (error) { const code = error instanceof Error ? error.message : 'phase_update_failed'; return reply.code(code === 'project_not_found' || code === 'phase_not_found' ? 404 : code === 'phase_duplicate_code' ? 409 : 400).send({ error: code }) }
})
app.post<{ Params: { projectId: string }; Body: { phaseIds: string[] } }>('/api/projects/:projectId/phases/reorder', async (request, reply) => {
  try { return await reorderProjectPhases(request.params.projectId, request.body) }
  catch (error) { const code = error instanceof Error ? error.message : 'phase_reorder_failed'; return reply.code(code === 'project_not_found' || code === 'phase_not_found' ? 404 : 400).send({ error: code }) }
})
app.delete<{ Params: { projectId: string; phaseId: string } }>('/api/projects/:projectId/phases/:phaseId', async (request, reply) => {
  try { const phase = await deleteProjectPhase(request.params.projectId, request.params.phaseId); if (!phase) return reply.code(404).send({ error: 'phase_not_found' }); return reply.code(204).send() }
  catch (error) { const code = error instanceof Error ? error.message : 'phase_delete_failed'; return reply.code(code === 'project_not_found' || code === 'phase_not_found' ? 404 : code === 'phase_has_tasks' ? 409 : 400).send({ error: code, message: code === 'phase_has_tasks' ? '阶段仍被任务引用，无法删除' : undefined }) }
})
app.get<{ Params: { projectId: string }; Querystring: { q?: string; phaseId?: string; status?: string; priority?: string } }>('/api/projects/:projectId/tasks', async (request, reply) => {
  try { return await listProjectTasks(request.params.projectId, request.query) }
  catch (error) { const code = error instanceof Error ? error.message : 'task_list_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string; taskId: string } }>('/api/projects/:projectId/tasks/:taskId/dependencies', async (request, reply) => {
  try { return await listTaskDependencies(request.params.projectId, request.params.taskId) }
  catch (error) { const code = error instanceof Error ? error.message : 'dependency_list_failed'; return reply.code(code === 'dependency_task_not_found' ? 404 : 400).send({ error: code }) }
})
app.post<{ Params: { projectId: string; taskId: string }; Body: { dependsOnTaskId?: unknown } }>('/api/projects/:projectId/tasks/:taskId/dependencies', async (request, reply) => {
  try {
    const dependsOnTaskId = request.body?.dependsOnTaskId
    if (typeof dependsOnTaskId !== 'string' || !dependsOnTaskId) return reply.code(400).send({ error: 'dependency_task_id_required' })
    return reply.code(201).send(await createDependency(request.params.projectId, request.params.taskId, dependsOnTaskId))
  } catch (error) { const code = error instanceof Error ? error.message : 'dependency_create_failed'; return reply.code(code === 'dependency_task_not_found' ? 404 : code === 'dependency_duplicate' || code === 'dependency_cycle' ? 409 : 400).send({ error: code }) }
})
app.delete<{ Params: { projectId: string; taskId: string; dependencyId: string } }>('/api/projects/:projectId/tasks/:taskId/dependencies/:dependencyId', async (request, reply) => {
  try { const removed = await deleteDependency(request.params.projectId, request.params.taskId, request.params.dependencyId); if (!removed) return reply.code(404).send({ error: 'dependency_not_found' }); return reply.code(204).send() }
  catch (error) { const code = error instanceof Error ? error.message : 'dependency_delete_failed'; return reply.code(code === 'dependency_task_not_found' ? 404 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string; taskId: string } }>('/api/projects/:projectId/tasks/:taskId', async (request, reply) => {
  const task = await getProjectTask(request.params.projectId, request.params.taskId)
  if (!task) return reply.code(404).send({ error: 'task_not_found' })
  return task
})
app.post<{ Params: { projectId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/tasks', async (request, reply) => {
  try { return reply.code(201).send(await createProjectTask(request.params.projectId, request.body as never)) }
  catch (error) { const code = error instanceof Error ? error.message : 'task_create_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.patch<{ Params: { projectId: string; taskId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/tasks/:taskId', async (request, reply) => {
  try { const task = await updateProjectTask(request.params.projectId, request.params.taskId, request.body as never); if (!task) return reply.code(404).send({ error: 'task_not_found' }); return task }
  catch (error) { const code = error instanceof Error ? error.message : 'task_update_failed'; return reply.code(code === 'task_not_found' ? 404 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string }; Querystring: { q?: string; status?: string; type?: string; ownerName?: string; range?: string } }>('/api/projects/:projectId/milestones', async (request, reply) => {
  try { return await listProjectMilestones(request.params.projectId, request.query) }
  catch (error) { const code = error instanceof Error ? error.message : 'milestone_list_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string; milestoneId: string } }>('/api/projects/:projectId/milestones/:milestoneId', async (request, reply) => {
  try { const item = await getProjectMilestone(request.params.projectId, request.params.milestoneId); if (!item) return reply.code(404).send({ error: 'milestone_not_found' }); return item }
  catch (error) { const code = error instanceof Error ? error.message : 'milestone_detail_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.post<{ Params: { projectId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/milestones', async (request, reply) => {
  try { return reply.code(201).send(await createProjectMilestone(request.params.projectId, request.body as never)) }
  catch (error) { const code = isUniqueViolation(error) ? 'milestone_duplicate' : error instanceof Error ? error.message : 'milestone_create_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'milestone_duplicate' ? 409 : 400).send({ error: code }) }
})
app.patch<{ Params: { projectId: string; milestoneId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/milestones/:milestoneId', async (request, reply) => {
  try { const item = await updateProjectMilestone(request.params.projectId, request.params.milestoneId, request.body as never); if (!item) return reply.code(404).send({ error: 'milestone_not_found' }); return item }
  catch (error) { const code = isUniqueViolation(error) ? 'milestone_duplicate' : error instanceof Error ? error.message : 'milestone_update_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'milestone_duplicate' ? 409 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string }; Querystring: { q?: string; level?: string; status?: string; ownerName?: string; source?: string; range?: string; includeClosed?: string } }>('/api/projects/:projectId/risks', async (request, reply) => {
  try { return await listProjectRisks(request.params.projectId, request.query) } catch (error) { const code = error instanceof Error ? error.message : 'risk_list_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string; riskId: string } }>('/api/projects/:projectId/risks/:riskId', async (request, reply) => {
  try { const item = await getProjectRisk(request.params.projectId, request.params.riskId); if (!item) return reply.code(404).send({ error: 'risk_not_found' }); return item } catch (error) { const code = error instanceof Error ? error.message : 'risk_detail_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.post<{ Params: { projectId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/risks', async (request, reply) => {
  try { return reply.code(201).send(await createProjectRisk(request.params.projectId, request.body as never)) } catch (error) { const code = isUniqueViolation(error) ? 'risk_duplicate' : error instanceof Error ? error.message : 'risk_create_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'risk_duplicate' ? 409 : 400).send({ error: code }) }
})
app.patch<{ Params: { projectId: string; riskId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/risks/:riskId', async (request, reply) => {
  try { const item = await updateProjectRisk(request.params.projectId, request.params.riskId, request.body as never); if (!item) return reply.code(404).send({ error: 'risk_not_found' }); return item } catch (error) { const code = isUniqueViolation(error) ? 'risk_duplicate' : error instanceof Error ? error.message : 'risk_update_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'risk_duplicate' ? 409 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string }; Querystring: { q?: string; category?: string; priority?: string; status?: string; ownerName?: string; counterparty?: string; range?: string; includeClosed?: string } }>('/api/projects/:projectId/coordination', async (request, reply) => {
  try { return await listProjectCoordinationItems(request.params.projectId, request.query) } catch (error) { const code = error instanceof Error ? error.message : 'coordination_list_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string; itemId: string } }>('/api/projects/:projectId/coordination/:itemId', async (request, reply) => {
  try { const item = await getProjectCoordinationItem(request.params.projectId, request.params.itemId); if (!item) return reply.code(404).send({ error: 'coordination_not_found' }); return item } catch (error) { const code = error instanceof Error ? error.message : 'coordination_detail_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.post<{ Params: { projectId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/coordination', async (request, reply) => {
  try { return reply.code(201).send(await createProjectCoordinationItem(request.params.projectId, request.body as never)) } catch (error) { const code = isUniqueViolation(error) ? 'coordination_duplicate' : error instanceof Error ? error.message : 'coordination_create_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'coordination_duplicate' ? 409 : 400).send({ error: code }) }
})
app.patch<{ Params: { projectId: string; itemId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/coordination/:itemId', async (request, reply) => {
  try { const item = await updateProjectCoordinationItem(request.params.projectId, request.params.itemId, request.body as never); if (!item) return reply.code(404).send({ error: 'coordination_not_found' }); return item } catch (error) { const code = isUniqueViolation(error) ? 'coordination_duplicate' : error instanceof Error ? error.message : 'coordination_update_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'coordination_duplicate' ? 409 : 400).send({ error: code }) }
})
app.get<{ Params:{projectId:string}; Querystring:{q?:string;stageCode?:string;status?:string;responsibleParty?:string;range?:string;includeCompleted?:string} }>('/api/projects/:projectId/approvals',async(request,reply)=>{try{return await listProjectApprovals(request.params.projectId,request.query)}catch(error){const code=error instanceof Error?error.message:'approval_list_failed';return reply.code(code==='project_not_found'?404:400).send({error:code})}})
app.get<{ Params:{projectId:string;approvalId:string} }>('/api/projects/:projectId/approvals/:approvalId',async(request,reply)=>{try{const item=await getProjectApproval(request.params.projectId,request.params.approvalId);if(!item)return reply.code(404).send({error:'approval_not_found'});return item}catch(error){const code=error instanceof Error?error.message:'approval_detail_failed';return reply.code(code==='project_not_found'?404:400).send({error:code})}})
app.post<{ Params:{projectId:string};Body:Record<string,unknown> }>('/api/projects/:projectId/approvals',async(request,reply)=>{try{return reply.code(201).send(await createProjectApproval(request.params.projectId,request.body as never))}catch(error){const code=isUniqueViolation(error)?'approval_duplicate':error instanceof Error?error.message:'approval_create_failed';return reply.code(code==='project_not_found'?404:code==='approval_duplicate'?409:400).send({error:code})}})
app.patch<{ Params:{projectId:string;approvalId:string};Body:Record<string,unknown> }>('/api/projects/:projectId/approvals/:approvalId',async(request,reply)=>{try{const item=await updateProjectApproval(request.params.projectId,request.params.approvalId,request.body as never);if(!item)return reply.code(404).send({error:'approval_not_found'});return item}catch(error){const code=isUniqueViolation(error)?'approval_duplicate':error instanceof Error?error.message:'approval_update_failed';return reply.code(code==='project_not_found'?404:code==='approval_duplicate'?409:400).send({error:code})}})
app.get<{ Params: { projectId: string }; Querystring:{scope?:string} }>('/api/projects/:projectId/knowledge', async (request, reply) => {
  try { return await (request.query.scope === 'all-projects' ? getAllProjectsKnowledgeWorkspace(request.params.projectId) : getProjectKnowledgeWorkspace(request.params.projectId)) }
  catch (error) { const code = error instanceof Error ? error.message : 'knowledge_workspace_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'knowledge_portfolio_forbidden' ? 403 : code === 'knowledge_portfolio_scope_empty' ? 403 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/knowledge/folders', async (request, reply) => {
  try { return await listProjectKnowledgeFolders(request.params.projectId) }
  catch (error) { const code = error instanceof Error ? error.message : 'knowledge_folder_list_failed'; return reply.code(code === 'project_not_found' ? 404 : 400).send({ error: code }) }
})
app.post<{ Params: { projectId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/knowledge/folders', async (request, reply) => {
  try { return reply.code(201).send(await createProjectKnowledgeFolder(request.params.projectId, request.body as never)) }
  catch (error) { const code = isUniqueViolation(error) ? 'knowledge_folder_duplicate' : error instanceof Error ? error.message : 'knowledge_folder_create_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'knowledge_folder_duplicate' ? 409 : 400).send({ error: code }) }
})
app.patch<{ Params: { projectId: string; folderId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/knowledge/folders/:folderId', async (request, reply) => {
  try { const folder = await updateProjectKnowledgeFolder(request.params.projectId, request.params.folderId, request.body as never); if (!folder) return reply.code(404).send({ error: 'knowledge_folder_not_found' }); return folder }
  catch (error) { const code = isUniqueViolation(error) ? 'knowledge_folder_duplicate' : error instanceof Error ? error.message : 'knowledge_folder_update_failed'; return reply.code(code === 'project_not_found' || code === 'knowledge_folder_not_found' ? 404 : code === 'knowledge_folder_duplicate' ? 409 : 400).send({ error: code }) }
})
app.delete<{ Params: { projectId: string; folderId: string } }>('/api/projects/:projectId/knowledge/folders/:folderId', async (request, reply) => {
  try { const removed = await deleteProjectKnowledgeFolder(request.params.projectId, request.params.folderId); if (!removed) return reply.code(404).send({ error: 'knowledge_folder_not_found' }); return reply.code(204).send() }
  catch (error) { const code = error instanceof Error ? error.message : 'knowledge_folder_delete_failed'; return reply.code(code === 'project_not_found' ? 404 : code === 'knowledge_folder_not_empty' || code === 'knowledge_folder_has_documents' ? 409 : 400).send({ error: code }) }
})
app.get<{ Params: { projectId: string }; Querystring: { q?: string; folderId?: string; status?: string; fileType?: string; includeArchived?: string } }>('/api/projects/:projectId/knowledge/documents', async (request, reply) => {
  try { return await listProjectKnowledgeDocuments(request.params.projectId, request.query) }
  catch (error) { const code = error instanceof Error ? error.message : 'knowledge_document_list_failed'; return reply.code(code === 'project_not_found' || code === 'knowledge_folder_not_found' ? 404 : 400).send({ error: code }) }
})
app.post<{ Params: { projectId: string; kind: 'implementation-plan' | 'meeting-minutes' | 'weekly-report' | 'market-solution-meeting-todos' | 'delivery-meeting-todos' | 'government-enterprise-opportunity' } }>('/api/projects/:projectId/process-documents/:kind', async (request, reply) => {
  try {
    const document = await createProjectProcessDocument(request.params.projectId, request.params.kind, await readKnowledgeUpload(request))
    if (request.params.kind === 'market-solution-meeting-todos' || request.params.kind === 'government-enterprise-opportunity') {
      const indexing = await parseAndIndexProjectDocument(request.params.projectId, document.id)
      return reply.code(201).send({ ...document, indexing })
    }
    return reply.code(201).send(document)
  }
  catch (error) { return sendKnowledgeError(reply, error, 'project_process_document_upload_failed') }
})
app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/knowledge/documents', async (request, reply) => {
  try { return reply.code(201).send(await createProjectKnowledgeDocument(request.params.projectId, await readKnowledgeUpload(request))) }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_document_upload_failed') }
})
app.get<{ Params: { projectId: string; documentId: string } }>('/api/projects/:projectId/knowledge/documents/:documentId', async (request, reply) => {
  try { const document = await getProjectKnowledgeDocument(request.params.projectId, request.params.documentId); if (!document) return reply.code(404).send({ error: 'knowledge_document_not_found' }); return document }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_document_detail_failed') }
})
app.patch<{ Params: { projectId: string; documentId: string }; Body: Record<string, unknown> }>('/api/projects/:projectId/knowledge/documents/:documentId', async (request, reply) => {
  try { const document = await updateProjectKnowledgeDocument(request.params.projectId, request.params.documentId, request.body as never); if (!document) return reply.code(404).send({ error: 'knowledge_document_not_found' }); return document }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_document_update_failed') }
})
app.get<{ Params: { projectId: string; documentId: string } }>('/api/projects/:projectId/knowledge/documents/:documentId/versions', async (request, reply) => {
  try { const versions = await listProjectKnowledgeDocumentVersions(request.params.projectId, request.params.documentId); if (!versions) return reply.code(404).send({ error: 'knowledge_document_not_found' }); return versions }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_version_list_failed') }
})
app.post<{ Params: { projectId: string; documentId: string } }>('/api/projects/:projectId/knowledge/documents/:documentId/versions', async (request, reply) => {
  try { const version = await createProjectKnowledgeDocumentVersion(request.params.projectId, request.params.documentId, await readKnowledgeUpload(request)); if (!version) return reply.code(404).send({ error: 'knowledge_document_not_found' }); return reply.code(201).send(version) }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_version_upload_failed') }
})
app.get<{ Params: { projectId: string; documentId: string } }>('/api/projects/:projectId/knowledge/documents/:documentId/download', async (request, reply) => {
  try { const download = await getProjectKnowledgeDocumentDownload(request.params.projectId, request.params.documentId); if (!download) return reply.code(404).send({ error: 'knowledge_document_not_found' }); return sendDownload(reply, download) }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_document_download_failed') }
})
app.get<{ Params: { projectId: string; documentId: string; versionId: string } }>('/api/projects/:projectId/knowledge/documents/:documentId/versions/:versionId/download', async (request, reply) => {
  try { const download = await getProjectKnowledgeDocumentDownload(request.params.projectId, request.params.documentId, request.params.versionId); if (!download) return reply.code(404).send({ error: 'knowledge_document_not_found' }); return sendDownload(reply, download) }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_version_download_failed') }
})
app.post<{ Params: { projectId: string; documentId: string; versionId: string } }>('/api/projects/:projectId/knowledge/documents/:documentId/versions/:versionId/parse', async (request, reply) => {
  try { const result = await parseProjectKnowledgeDocumentVersion(request.params.projectId, request.params.documentId, request.params.versionId); if (!result) return reply.code(404).send({ error: 'knowledge_version_not_found' }); return result }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_parse_failed') }
})
app.get<{ Params: { projectId: string; documentId: string; versionId: string } }>('/api/projects/:projectId/knowledge/documents/:documentId/versions/:versionId/chunks', async (request, reply) => {
  try { const result = await listProjectDocumentVersionChunks(request.params.projectId, request.params.documentId, request.params.versionId); if (!result) return reply.code(404).send({ error: 'knowledge_version_not_found' }); return result }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_chunk_list_failed') }
})
app.put<{ Params: { projectId: string; documentId: string; versionId: string }; Body: unknown }>('/api/projects/:projectId/knowledge/documents/:documentId/versions/:versionId/chunks', async (request, reply) => {
  try { const result = await replaceProjectDocumentVersionChunks(request.params.projectId, request.params.documentId, request.params.versionId, request.body); if (!result) return reply.code(404).send({ error: 'knowledge_version_not_found' }); return result }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_vector_index_failed') }
})
app.post<{ Params: { projectId: string; documentId: string; versionId: string } }>('/api/projects/:projectId/knowledge/documents/:documentId/versions/:versionId/embed', async (request, reply) => {
  try { const result = await indexProjectDocumentInLlmWiki(request.params.projectId, request.params.documentId, request.params.versionId); if (!result) return reply.code(404).send({ error: 'knowledge_version_not_found' }); return result }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_embedding_failed') }
})
app.post<{ Params: { projectId: string; documentId: string; versionId: string } }>('/api/projects/:projectId/knowledge/documents/:documentId/versions/:versionId/embed-pgvector', async (request, reply) => {
  try { const result = await embedProjectDocumentVersion(request.params.projectId, request.params.documentId, request.params.versionId); if (!result) return reply.code(404).send({ error: 'knowledge_version_not_found' }); return { ...result, fallback: true } }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_embedding_failed') }
})
app.post<{ Params: { projectId: string }; Body: HybridSearchInput }>('/api/projects/:projectId/knowledge/hybrid-search', async (request, reply) => {
  try {
    const query = typeof request.body.q === 'string' ? request.body.q.normalize('NFKC').trim() : ''
    if (query.length < 2 || query.length > 200) throw new Error('knowledge_search_query_invalid')
    const limit = Number(request.body.limit ?? 20)
    const project = await getProject(request.params.projectId)
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    if (project.code === 'OPP-MASTER') return await searchAllProjectsKnowledgeHybrid(request.params.projectId, request.body)
    return await llmWikiPrimarySearch(request.params.projectId, query, { topK: Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20, projectName: project.name })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'knowledge_hybrid_search_failed'
    if (code.startsWith('llm_wiki_')) {
      try { return { ...(await searchProjectKnowledgeHybrid(request.params.projectId, request.body)), degraded: true, fallback: 'pgvector', warning: code } }
      catch (fallbackError) {
        const fallbackCode = fallbackError instanceof Error ? fallbackError.message : ''
        const embeddingFailure = ['knowledge_embedding_provider_failed','knowledge_embedding_response_invalid','knowledge_embedding_dimensions_invalid','knowledge_embedding_timeout'].includes(fallbackCode)
        if (embeddingFailure && request.body.mode !== 'semantic') {
          const filters = Object.fromEntries(Object.entries(request.body).filter(([key, value]) => ['q','folderId','fileType','status','updatedFrom','updatedTo','includeArchived','limit','offset'].includes(key) && value !== undefined).map(([key, value]) => [key, String(value)]))
          const fallback = await searchProjectKnowledgeContent(request.params.projectId, filters)
          return { ...fallback, requestedMode: 'hybrid', mode: 'keyword', degraded: true, fallback: 'full-text', warning: fallbackCode }
        }
        return sendKnowledgeError(reply, fallbackError, 'knowledge_hybrid_search_failed')
      }
    }
    return sendKnowledgeError(reply, error, 'knowledge_hybrid_search_failed')
  }
})
app.get<{ Params: { projectId: string }; Querystring: KnowledgeContentSearchFilters }>('/api/projects/:projectId/knowledge/content-search', async (request, reply) => {
  try { return await searchProjectKnowledgeContent(request.params.projectId, request.query) }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_search_failed') }
})
app.post<{ Params: { projectId: string }; Body: unknown }>('/api/projects/:projectId/knowledge/vector-search', async (request, reply) => {
  try { return await searchProjectKnowledgeVectors(request.params.projectId, request.body) }
  catch (error) { return sendKnowledgeError(reply, error, 'knowledge_vector_search_failed') }
})
registerProjectDocumentRoutes(app)
app.get<{ Params:{projectId:string} }>('/api/projects/:projectId/ai/scopes',async(request,reply)=>{try{return await getProjectAiScopes(request.params.projectId)}catch(error){return sendAiError(reply,error,'ai_scope_list_failed')}})
app.get('/api/ai/models', async (_request, reply) => { try { return await harness.listModels() } catch (error) { return sendAiError(reply, error, 'harness_models_failed') } })
app.get<{ Params:{projectId:string};Querystring:{status?:string;limit?:string;cursor?:string} }>('/api/projects/:projectId/ai/conversations',async(request,reply)=>{try{return await listProjectAiConversations(request.params.projectId,request.query)}catch(error){return sendAiError(reply,error,'ai_conversation_list_failed')}})
app.post<{ Params:{projectId:string};Body:{title?:string} }>('/api/projects/:projectId/ai/conversations',async(request,reply)=>{try{const conversation=await createProjectAiConversation(request.params.projectId,request.body??{});const session=await harness.createSession();const bound=await bindHarnessSession(request.params.projectId,conversation.id,session,harness.selection);return reply.code(201).send(bound)}catch(error){return sendAiError(reply,error,'ai_conversation_create_failed')}})
app.get<{ Params:{projectId:string;conversationId:string} }>('/api/projects/:projectId/ai/conversations/:conversationId',async(request,reply)=>{try{const conversation=await getProjectAiConversation(request.params.projectId,request.params.conversationId);if(!conversation)return reply.code(404).send({error:'ai_conversation_not_found'});return conversation}catch(error){return sendAiError(reply,error,'ai_conversation_detail_failed')}})
app.patch<{ Params:{projectId:string;conversationId:string};Body:{title?:string;status?:string} }>('/api/projects/:projectId/ai/conversations/:conversationId',async(request,reply)=>{try{const conversation=await updateProjectAiConversation(request.params.projectId,request.params.conversationId,request.body);if(!conversation)return reply.code(404).send({error:'ai_conversation_not_found'});return conversation}catch(error){return sendAiError(reply,error,'ai_conversation_update_failed')}})
app.delete<{ Params:{projectId:string;conversationId:string} }>('/api/projects/:projectId/ai/conversations/:conversationId',async(request,reply)=>{try{const conversation=await getProjectAiConversation(request.params.projectId,request.params.conversationId);if(!conversation)return reply.code(404).send({error:'ai_conversation_not_found'});if(conversation.harnessSessionId)await harness.cancel(conversation.harnessSessionId).catch(()=>undefined);await deleteProjectAiConversation(request.params.projectId,request.params.conversationId);return reply.code(204).send()}catch(error){return sendAiError(reply,error,'ai_conversation_delete_failed')}})
app.get<{ Params:{projectId:string;conversationId:string};Querystring:{limit?:string;before?:string;after?:string} }>('/api/projects/:projectId/ai/conversations/:conversationId/messages',async(request,reply)=>{try{const result=await listProjectAiMessages(request.params.projectId,request.params.conversationId,request.query);if(!result)return reply.code(404).send({error:'ai_conversation_not_found'});return result}catch(error){return sendAiError(reply,error,'ai_message_list_failed')}})
app.post<{ Params:{projectId:string;conversationId:string};Body:{content?:string;requestId?:string;stream?:boolean} }>('/api/projects/:projectId/ai/conversations/:conversationId/messages',async(request,reply)=>{try{const conversation=await getProjectAiConversation(request.params.projectId,request.params.conversationId);if(!conversation)return reply.code(404).send({error:'ai_conversation_not_found'});const selection=harness.selection;if(!conversation.harnessSessionId||conversation.provider!==selection.provider||conversation.model!==selection.model){const session=await harness.createSession();await bindHarnessSession(request.params.projectId,conversation.id,session,selection)}if(request.body?.stream!==false){const result=await aiStreams.start(request.params.projectId,request.params.conversationId,request.body?.content??'',request.body?.requestId??crypto.randomUUID());return reply.code(202).send(result)}const result=await answerProjectQuestion(request.params.projectId,request.params.conversationId,request.body?.content??'',{harness});return result}catch(error){return sendAiError(reply,error,'ai_message_create_failed')}})
app.get<{ Params:{projectId:string;conversationId:string};Querystring:{after?:string} }>('/api/projects/:projectId/ai/conversations/:conversationId/events',async(request,reply)=>{const conversation=await getProjectAiConversation(request.params.projectId,request.params.conversationId);if(!conversation)return reply.code(404).send({error:'ai_conversation_not_found'});reply.hijack();const response=reply.raw;response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});const after=Number(request.query.after??request.headers['last-event-id']??0)||0;const send=(event:any)=>response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);const unsubscribe=aiStreams.subscribe(request.params.projectId,request.params.conversationId,after,send);const heartbeat=setInterval(()=>response.write(': heartbeat\n\n'),15_000);request.raw.once('close',()=>{clearInterval(heartbeat);unsubscribe()})})
app.post<{ Params:{projectId:string;conversationId:string} }>('/api/projects/:projectId/ai/conversations/:conversationId/cancel',async(request,reply)=>{try{const conversation=await getProjectAiConversation(request.params.projectId,request.params.conversationId);if(!conversation)return reply.code(404).send({error:'ai_conversation_not_found'});const cancelled=await aiStreams.cancel(request.params.projectId,request.params.conversationId);if(!cancelled&&conversation.harnessSessionId)await harness.cancel(conversation.harnessSessionId);return {cancelled:true}}catch(error){return sendAiError(reply,error,'ai_conversation_cancel_failed')}})
app.post<{ Params:{projectId:string;conversationId:string;messageId:string};Body:{requestId?:string} }>('/api/projects/:projectId/ai/conversations/:conversationId/messages/:messageId/retry',async(request,reply)=>{try{const result=await aiStreams.retry(request.params.projectId,request.params.conversationId,request.params.messageId,request.body?.requestId??crypto.randomUUID());if(!result)return reply.code(404).send({error:'ai_retry_source_not_found'});return reply.code(202).send(result)}catch(error){return sendAiError(reply,error,'ai_message_retry_failed')}})
app.get<{Params:{projectId:string;conversationId:string;messageId:string}}>('/api/projects/:projectId/ai/conversations/:conversationId/messages/:messageId/feedback',async(request,reply)=>{try{const result=await getProjectAiMessageFeedback(request.params.projectId,request.params.conversationId,request.params.messageId);return result??reply.code(404).send({error:'ai_feedback_not_found'})}catch(error){return sendAiError(reply,error,'ai_feedback_get_failed')}})
app.put<{Params:{projectId:string;conversationId:string;messageId:string};Body:{value?:string;note?:string}}>('/api/projects/:projectId/ai/conversations/:conversationId/messages/:messageId/feedback',async(request,reply)=>{try{const result=await setProjectAiMessageFeedback(request.params.projectId,request.params.conversationId,request.params.messageId,request.body);if(!result)return reply.code(404).send({error:'ai_message_not_found'});return result}catch(error){return sendAiError(reply,error,'ai_feedback_set_failed')}})

function startOfWeek(value: Date) {
  const result = new Date(value)
  const day = result.getDay()
  const distance = day === 0 ? 6 : day - 1
  result.setDate(result.getDate() - distance)
  result.setHours(0, 0, 0, 0)
  return result
}

async function readImportUpload(request: { parts: () => AsyncIterableIterator<any> }) {
  let kind: string | undefined
  let file: { fileName: string; body: Buffer } | undefined
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (file) throw new Error('import_file_count_invalid')
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of part.file) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > maxUploadBytes) throw new Error('knowledge_file_size_invalid'); chunks.push(buffer) }
      if (part.file.truncated) throw new Error('knowledge_file_size_invalid')
      file = { fileName: part.filename, body: Buffer.concat(chunks) }
    } else if (part.fieldname === 'kind') {
      if (kind !== undefined) throw new Error('import_field_duplicate')
      kind = String(part.value)
    }
  }
  if (!kind) throw new Error('import_kind_required')
  if (!file) throw new Error('import_file_required')
  return { kind, ...file }
}

async function readKnowledgeUpload(request: { parts: () => AsyncIterableIterator<any> }): Promise<KnowledgeDocumentUpload> {
  const fields: Record<string, string> = {}; let file: { fileName: string; mimeType?: string; body: Buffer } | undefined
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (file) throw new Error('knowledge_file_count_invalid')
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of part.file) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > maxUploadBytes) throw new Error('knowledge_file_size_invalid'); chunks.push(buffer) }
      if (part.file.truncated) throw new Error('knowledge_file_size_invalid')
      file = { fileName: part.filename, mimeType: part.mimetype, body: Buffer.concat(chunks) }
    } else {
      if (fields[part.fieldname] !== undefined) throw new Error('knowledge_field_duplicate')
      if (!['name', 'folderId', 'status', 'changeSummary'].includes(part.fieldname)) throw new Error('knowledge_upload_field_invalid')
      fields[part.fieldname] = String(part.value)
    }
  }
  if (!file) throw new Error('knowledge_file_required')
  return { ...file, fields }
}
async function sendDownload(reply: any, download: Awaited<ReturnType<typeof getProjectKnowledgeDocumentDownload>> & {}) {
  const safe = download.fileName.replace(/[^\x20-\x7E]|[\r\n"\\]/g, '_') || 'download'
  const encoded = encodeURIComponent(download.fileName).replace(/'/g, '%27')
  reply.header('Content-Type', download.mimeType).header('Content-Disposition', `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store').header('Pragma', 'no-cache')
  if (download.object.contentLength !== null) reply.header('Content-Length', String(download.object.contentLength))
  const body = download.object.body
  if (!body) throw new Error('knowledge_document_file_missing')
  if (body instanceof Readable) return reply.send(body)
  const bytes = await body.transformToByteArray()
  return reply.send(Buffer.from(bytes))
}
function sendAiError(reply: any, error: unknown, fallback: string) {
  const code = error instanceof HarnessError ? error.code : error instanceof Error ? error.message : fallback
  const status = code === 'project_not_found' || code === 'ai_conversation_not_found' ? 404 : code === 'harness_timeout' ? 504 : code === 'harness_unavailable' ? 503 : code === 'harness_http_error' || code === 'harness_response_invalid' || code === 'harness_rpc_error' ? 502 : code === fallback ? 500 : 400
  if (status >= 500) app.log.error({ error }, fallback)
  return reply.code(status).send({ error: code })
}
function importChangeActor(request: { id: string; authUser?: { username: string; displayName: string | null } }) {
  return {
    actorId: request.authUser?.username,
    actorName: request.authUser?.displayName ?? request.authUser?.username,
    requestId: request.id,
  }
}

function sendProjectImportChangeError(reply: any, error: unknown, fallback: string) {
  const code = error instanceof Error ? error.message : fallback
  const notFound = new Set(['project_not_found', 'import_batch_not_found', 'entity_not_found'])
  const conflicts = new Set(['import_base_batch_changed', 'import_preview_fingerprint_changed', 'import_critical_changes_confirmation_required', 'import_batch_not_confirmable'])
  const status = notFound.has(code) ? 404 : conflicts.has(code) ? 409 : code === 'import_change_tracking_disabled' ? 503 : code === 'import_format_unsupported' ? 415 : 400
  return reply.code(status).send({ error: code })
}

function sendKnowledgeError(reply: any, error: unknown, fallback: string) {
  const raw = error instanceof Error ? error.message : fallback
  const publicCodes = new Set(['project_not_found','knowledge_folder_not_found','knowledge_document_not_found','knowledge_version_not_found','knowledge_document_file_missing','knowledge_file_size_invalid','knowledge_file_type_unsupported','knowledge_file_empty','knowledge_file_name_invalid','knowledge_document_name_invalid','knowledge_document_status_invalid','knowledge_document_body_invalid','knowledge_document_field_invalid','knowledge_file_count_invalid','knowledge_file_required','knowledge_field_duplicate','knowledge_upload_field_invalid','knowledge_text_too_long','knowledge_folder_id_invalid','knowledge_document_id_invalid','knowledge_version_id_invalid','project_id_invalid','knowledge_version_not_current','knowledge_document_not_indexable','knowledge_chunks_required','knowledge_chunks_limit_exceeded','knowledge_chunk_invalid','knowledge_chunk_field_invalid','knowledge_chunk_index_invalid','knowledge_chunk_content_invalid','knowledge_chunk_title_invalid','knowledge_chunk_section_invalid','knowledge_chunk_page_invalid','knowledge_chunk_token_count_invalid','knowledge_chunk_metadata_invalid','knowledge_chunk_embedding_invalid','knowledge_vector_search_body_invalid','knowledge_vector_search_field_invalid','knowledge_vector_search_limit_invalid','knowledge_vector_search_score_invalid','knowledge_vector_search_embedding_invalid','knowledge_parse_type_unsupported','knowledge_parse_file_empty','knowledge_parse_no_text_layer','knowledge_parse_no_text','knowledge_parse_text_limit_exceeded','knowledge_parse_chunk_limit_exceeded','knowledge_parse_page_limit_exceeded','knowledge_parse_page_items_limit_exceeded','knowledge_parse_sheet_limit_exceeded','knowledge_parse_row_limit_exceeded','knowledge_parse_slide_limit_exceeded','knowledge_parse_container_limit_exceeded','knowledge_parse_container_invalid','knowledge_parse_encoding_invalid','knowledge_parse_file_signature_invalid','knowledge_parse_file_size_invalid','knowledge_parse_file_size_mismatch','knowledge_parse_checksum_mismatch','knowledge_ocr_language_data_missing','knowledge_ocr_page_limit_exceeded','knowledge_ocr_image_limit_exceeded','knowledge_ocr_image_invalid','knowledge_ocr_pdf_render_failed','knowledge_ocr_pdf_invalid','knowledge_ocr_timeout','knowledge_ocr_document_timeout','knowledge_ocr_engine_unavailable','knowledge_ocr_failed','knowledge_ocr_no_text','knowledge_search_field_invalid','knowledge_search_query_invalid','knowledge_search_file_type_invalid','knowledge_search_status_invalid','knowledge_search_date_invalid','knowledge_search_date_range_invalid','knowledge_search_include_archived_invalid','knowledge_search_limit_invalid','knowledge_search_offset_invalid','knowledge_search_mode_invalid','knowledge_search_score_invalid','knowledge_document_not_parsed','knowledge_embedding_input_invalid','knowledge_embedding_provider_failed','knowledge_embedding_response_invalid','knowledge_embedding_dimensions_invalid','knowledge_embedding_timeout'])
  const multipartTooLarge = error && typeof error === 'object' && 'code' in error && ['FST_REQ_FILE_TOO_LARGE','FST_FILES_LIMIT','FST_PARTS_LIMIT'].includes(String((error as { code?: unknown }).code))
  const code = multipartTooLarge ? 'knowledge_file_size_invalid' : publicCodes.has(raw) ? raw : fallback
  const status = code === 'project_not_found' || code === 'knowledge_folder_not_found' || code === 'knowledge_document_not_found' || code === 'knowledge_version_not_found' ? 404 : code === 'knowledge_file_size_invalid' ? 413 : code === 'knowledge_file_type_unsupported' ? 415 : code.includes('duplicate') || code === 'knowledge_version_not_current' || code === 'knowledge_document_not_indexable' ? 409 : code === fallback ? 503 : 400
  if (code === fallback) app.log.error({ error }, fallback)
  return reply.code(status).send({ error: code })
}

const port = Number(process.env.PORT ?? 3100)
const host = process.env.HOST ?? '127.0.0.1'
await ensureObjectStorageBucket().catch(error => app.log.warn({ error }, 'Object storage bucket initialization skipped'))
await app.listen({ port, host })

// 个人报告采用幂等周期归总：默认每小时检查一次，单轮串行处理六个账号，避免启动时批量冲击数据库。
const personalReportIntervalMs = Math.max(15 * 60 * 1000, Number(process.env.PERSONAL_REPORT_INTERVAL_MS ?? 60 * 60 * 1000) || 60 * 60 * 1000)
let personalReportRun = false
async function runPersonalReportSchedule() {
  if (personalReportRun) return
  personalReportRun = true
  try {
    const now = new Date()
    const date = now.toISOString().slice(0, 10)
    for (const accountId of PERSONAL_ACCOUNTS) {
      try {
        await generatePersonalReport(accountId, 'daily', date)
        if (now.getUTCHours() === 23) await generatePersonalReport(accountId, 'weekly', date)
        if (now.getUTCDate() === new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()) await generatePersonalReport(accountId, 'monthly', date)
      } catch (error) { app.log.error({ accountId, error }, 'personal report schedule failed') }
    }
  } finally { personalReportRun = false }
}
setInterval(() => { void runPersonalReportSchedule() }, personalReportIntervalMs).unref()
void runPersonalReportSchedule()

const close = async () => {
  harnessMux.stop()
  await app.close()
  await redis.quit().catch(() => undefined)
  await pool.end()
}
process.once('SIGINT', close)
process.once('SIGTERM', close)

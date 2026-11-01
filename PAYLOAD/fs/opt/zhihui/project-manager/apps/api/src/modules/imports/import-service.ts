import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { parse } from 'csv-parse/sync'
import ExcelJS from 'exceljs'
import { db } from '../../db/client.ts'
import { auditLogs, importJobs, projectPhases, projects, tasks } from '../../db/schema.ts'
import { createProjectTask, listProjectTasks, updateProjectTask } from '../tasks/task-service.ts'
import { createProjectMilestone, listProjectMilestones, updateProjectMilestone } from '../milestones/milestone-service.ts'
import { createProjectRisk, listProjectRisks, updateProjectRisk } from '../risks/risk-service.ts'
import { createProjectPhase } from '../projects/phase-service.ts'
import { createProject, getProject, listProjects, updateProject } from '../projects/project-service.ts'
import { createProjectCoordinationItem, listProjectCoordinationItems, updateProjectCoordinationItem } from '../coordination/coordination-service.ts'
import { createProjectApproval, listProjectApprovals, updateProjectApproval } from '../approvals/approval-service.ts'
import { createProjectProcessDocument } from '../knowledge/knowledge-service.ts'
import { parseAndIndexProjectDocument } from '../knowledge/document-indexing-service.ts'
import { parseCoordinationExpectedTime } from './coordination-expected-time.ts'

export type ImportJobInput = {
  kind: string
  sourceName: string
}

export type ImportRow = Record<string, string> & { __sourceRow?: string }
export type ImportError = { row?: number; message: string }
export type ImportPreview = { headers: string[]; rows: ImportRow[]; errors: ImportError[]; totalRows: number }
export type BatchImportFile = { fileName: string; body: Buffer }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const taskHeaders = new Set(['wbsCode', 'name', 'description', 'phaseId', 'parentId', 'vendor', 'ownerName', 'priority', 'status', 'progress', 'plannedStartDate', 'plannedEndDate', 'actualStartDate', 'actualEndDate', 'deliverable'])
const riskHeaders = new Set(['code', 'name', 'description', 'impact', 'mitigation', 'level', 'status', 'ownerName', 'source', 'expectedResolutionDate', 'closedAt'])
const milestoneHeaders = new Set(['name', 'description', 'type', 'status', 'ownerName', 'plannedDate', 'actualDate', 'deliverable'])
const phaseHeaders = new Set(['name', 'code', 'status', 'progress', 'plannedStartDate', 'plannedEndDate'])
const coordinationHeaders = new Set(['code', 'category', 'title', 'description', 'impactText', 'explanationText', 'counterparty', 'ownerName', 'priority', 'status', 'progress', 'dueDate', 'resolvedAt', 'expectedResolutionText'])
const approvalHeaders = new Set(['stageCode', 'stageName', 'taskName', 'deliverable', 'responsibleParty', 'status', 'plannedStartDate', 'plannedEndDate', 'actualStartDate', 'actualEndDate', 'result', 'remark', 'sortOrder', 'sequence'])
const phaseStatuses = new Set(['not_started', 'ready', 'in_progress', 'delayed', 'completed', 'closed', 'cancelled', 'blocked'])
const coordinationPriorities = new Set(['low', 'medium', 'high', 'critical'])
const coordinationStatuses = new Set(['to_start', 'communicating', 'resolved', 'closed'])
const riskLevels = new Set(['low', 'medium', 'high', 'critical'])
const riskStatuses = new Set(['identified', 'following', 'mitigated', 'closed', 'accepted'])
const milestoneTypes = new Set(['key', 'important', 'normal'])
const milestoneStatuses = new Set(['not_started', 'in_progress', 'delayed', 'completed', 'cancelled'])
const taskStatuses = new Set(['not_started', 'ready', 'in_progress', 'delayed', 'completed', 'closed', 'cancelled', 'blocked'])
const taskPriorities = new Set(['low', 'medium', 'high', 'critical'])
const templateSheetNames: Record<string, string[]> = { tasks: ['详细实施计划（WBS分解）', 'WBS范围分解'], risks: ['风险与问题清单', '风险与依赖管控'], milestones: ['里程碑及关键节点计划总览', '关键里程碑计划'], phases: ['详细实施计划（WBS分解）', 'WBS范围分解'], approvals: ['立项报批推进计划'], coordination: ['需协调升级事项'] }
const headerAliases: Record<string, Record<string, string>> = {
  tasks: { 'WBS编号':'wbsCode','任务名称':'name','一级模块':'phaseName','二级模块':'moduleName','三级模块':'thirdModuleName','承建方':'vendor','责任人':'ownerName','开始时间':'plannedStartDate','计划完成时间':'plannedEndDate','完成进度':'progress','当前状态':'status','优先级':'priority','交付物/范围说明':'deliverable','延期原因及措施':'delayReason' },
  risks: { '序号':'sequence','风险等级':'level','风险/问题描述':'name','风险来源':'source','影响程度':'impactLevel','发生概率':'probability','应对措施':'mitigation','责任人':'ownerName','预计解决日期':'expectedResolutionDate','状态':'status','说明':'description' },
  milestones: { '序号':'sequence','里程碑节点★':'name','里程碑节点':'name','开始时间':'startDate','计划完成时间★':'plannedDate','计划完成时间':'plannedDate','当前状态':'status','完成时间':'actualDate','责任方':'ownerName','责任人':'ownerName','交付内容':'deliverable','修改说明':'description' },
  phases: { '一级模块':'name' },
  approvals: { '序号':'sequence','阶段':'stageName','任务':'taskName','状态':'status','计划开始':'plannedStartDate','计划完成':'plannedEndDate','责任单位':'responsibleParty','输出物/验收标准':'deliverable' },
  coordination: { '序号':'sequence','编号':'code','事项描述':'title','事项类别':'category','分类':'category','影响':'impactText','说明':'explanationText','下一步行动':'description','需支持/决策内容':'supportRequired','备注':'supportRequired','期望解决时间':'expectedResolutionText','截止日期':'expectedResolutionText','解决时间':'resolvedAt','解决日期':'resolvedAt','完成时间':'resolvedAt','状态':'status','当前状态':'status','责任人':'ownerName','协调方':'counterparty','责任方/对接方':'counterparty','优先级':'priority','完成进度':'progress' },
}

export async function listImportJobs(projectId: string) {
  assertUuid(projectId, 'project_id_invalid')
  await assertProject(projectId)
  return db.select().from(importJobs).where(eq(importJobs.projectId, projectId)).orderBy(desc(importJobs.createdAt), asc(importJobs.id))
}

export async function createImportJob(projectId: string, kind: string, sourceName: string) {
  assertUuid(projectId, 'project_id_invalid')
  await assertProject(projectId)
  validateText(kind, 'import_kind_required')
  validateText(sourceName, 'import_source_name_required')
  const [row] = await db.insert(importJobs).values({ projectId, kind: kind.trim(), sourceName: sourceName.trim() }).returning()
  return row
}

export async function previewImport(projectId: string, kind: string, sourceName: string, body: Buffer): Promise<ImportPreview> {
  assertUuid(projectId, 'project_id_invalid')
  await assertProject(projectId)
  assertSupportedFormat(kind, sourceName)
  let parsed: { headers: string[]; rows: ImportRow[] }
  try { parsed = await parseImportRows(kind, sourceName, body) }
  catch (error) { return { headers: [], rows: [], errors: [{ message: error instanceof Error ? error.message : 'import_file_invalid' }], totalRows: 0 } }
  const headers = kind === 'tasks' ? new Set([...taskHeaders, 'phaseName', 'moduleName', 'thirdModuleName', 'delayReason']) : kind === 'risks' ? new Set([...riskHeaders, 'sequence', 'impactLevel', 'probability']) : kind === 'milestones' ? new Set([...milestoneHeaders, 'sequence', 'startDate']) : kind === 'coordination' ? new Set([...coordinationHeaders, 'sequence', 'supportRequired']) : kind === 'approvals' ? approvalHeaders : phaseHeaders
  const errors: ImportError[] = []
  const unsupportedHeaders = parsed.headers.filter(header => header !== '__sourceRow' && !headers.has(header))
  for (const header of unsupportedHeaders) errors.push({ message: `import_column_unsupported:${header}` })
  parsed.rows.forEach((row, index) => {
    const { __sourceRow: _sourceRow, ...businessRow } = row
    try { if (kind === 'tasks') validateTaskRow(businessRow); else if (kind === 'risks') validateRiskRow(businessRow); else if (kind === 'milestones') validateMilestoneRow(businessRow); else if (kind === 'coordination') validateCoordinationRow(businessRow); else if (kind === 'approvals') validateApprovalRow(businessRow); else validatePhaseRow(businessRow, unsupportedHeaders) }
    catch (error) { errors.push({ row: Number(row.__sourceRow) || index + 2, message: error instanceof Error ? error.message : 'import_row_invalid' }) }
  })
  return { headers: parsed.headers, rows: parsed.rows, errors, totalRows: parsed.rows.length }
}

/** Execute either supported import kind while retaining the task-specific API. */
export async function executeImport(projectId: string, kind: string, sourceName: string, body: Buffer, progressContext?: { weekStart?: string; weekEnd?: string }) {
  assertSupportedFormat(kind, sourceName)
  const preview = await previewImport(projectId, kind, sourceName, body)
  const job = await createImportJob(projectId, kind, sourceName)
  await db.update(importJobs).set({ status: 'processing', totalRows: preview.totalRows, updatedAt: new Date() }).where(eq(importJobs.id, job.id))
  if (kind === 'tasks') return executeTaskSnapshotImport(projectId, sourceName, body, preview, job.id, progressContext)
  const rowErrors: ImportError[] = [...preview.errors]
  let successRows = 0
  const schemaErrors = preview.errors.some(error => error.row === undefined)
  const invalidRows = new Set(preview.errors.filter(error => error.row !== undefined).map(error => error.row))
  if (schemaErrors) for (const row of preview.rows) invalidRows.add(Number(row.__sourceRow) || 0)
  const phaseRows = await db.select().from(projectPhases).where(eq(projectPhases.projectId, projectId))
  const phaseIdsByName = new Map(phaseRows.map(phase => [phase.name.trim(), phase.id]))
  const existingTasksByWbs = kind === 'tasks' ? new Map((await listProjectTasks(projectId, {})).map(task => [task.wbsCode, task])) : new Map()
  const existingRisksByCode = kind === 'risks' ? new Map((await listProjectRisks(projectId, { includeClosed: 'true' })).map(risk => [risk.code, risk])) : new Map()
  const existingMilestonesByKey = kind === 'milestones' ? new Map((await listProjectMilestones(projectId, {})).map(item => [`${item.name}|${item.plannedDate}`, item])) : new Map()
  const existingCoordinationByCode = kind === 'coordination' ? new Map((await listProjectCoordinationItems(projectId, { includeClosed: 'true' })).map(item => [item.code, item])) : new Map()
   const existingApprovalsByKey = kind === 'approvals' ? new Map((await listProjectApprovals(projectId, { includeCompleted: 'true' })).items.map(item => [`${item.stageCode}|${item.taskName}`, item])) : new Map()
  if (kind === 'tasks') {
    const missingPhaseNames = [...new Set(preview.rows.map(row => row.phaseName?.trim()).filter((name): name is string => Boolean(name && !phaseIdsByName.has(name))))]
    for (const [index, name] of missingPhaseNames.entries()) {
      const phase = await createProjectPhase(projectId, { name, code: `IMP-${String(phaseRows.length + index + 1).padStart(2, '0')}`, status: 'not_started', progress: 0 })
      phaseIdsByName.set(name, phase.id)
    }
  }
  const seenWbsCodes = new Set<string>()
  for (const [index, row] of preview.rows.entries()) {
    const rowNumber = Number(row.__sourceRow) || index + 2
    if (invalidRows.has(rowNumber)) continue
    try {
      const { __sourceRow: _sourceRow, ...rowInput } = row as ImportRow
      const input: Record<string, unknown> = { ...rowInput }
      if (kind === 'tasks' && typeof input.wbsCode === 'string') {
        const originalWbsCode = input.wbsCode
        if (seenWbsCodes.has(originalWbsCode)) input.wbsCode = `${originalWbsCode}-R${rowNumber}`
        seenWbsCodes.add(String(input.wbsCode))
      }
      if (input.progress !== undefined && input.progress !== '') input.progress = Number(input.progress)
      if (kind === 'tasks' && typeof input.phaseName === 'string') { input.phaseId = phaseIdsByName.get(input.phaseName.trim()) ?? null; delete input.phaseName }
      if (kind === 'coordination') { if (!('dueDate' in input)) input.dueDate = null; if (!('resolvedAt' in input)) input.resolvedAt = null }
      for (const key of Object.keys(input)) if (input[key] === '') input[key] = null
      if (kind === 'tasks') { const existing = existingTasksByWbs.get(String(input.wbsCode)); if (existing) await updateProjectTask(projectId, existing.id, input as never); else { const created = await createProjectTask(projectId, input as never); existingTasksByWbs.set(created.wbsCode, created) } }
      else if (kind === 'risks') { const existing = existingRisksByCode.get(String(input.code)); const result = existing ? await updateProjectRisk(projectId, existing.id, input as never) : await createProjectRisk(projectId, input as never); if (result) existingRisksByCode.set(result.code, result) }
      else if (kind === 'milestones') { const key = `${String(input.name)}|${String(input.plannedDate)}`; const existing = existingMilestonesByKey.get(key); const result = existing ? await updateProjectMilestone(projectId, existing.id, input as never) : await createProjectMilestone(projectId, input as never); if (result) existingMilestonesByKey.set(key, result) }
       else if (kind === 'coordination') { const existing = existingCoordinationByCode.get(String(input.code)); const result = existing ? await updateProjectCoordinationItem(projectId, existing.id, input as never, new Date(), { inferResolvedAt: false }) : await createProjectCoordinationItem(projectId, input as never, new Date(), { inferResolvedAt: false }); if (result) existingCoordinationByCode.set(result.code, result) }
       else if (kind === 'approvals') { const stageName = String(input.stageName ?? '立项报批'); const stageCode = approvalStageCode(stageName); input.stageCode = stageCode; input.stageName = stageName; input.sortOrder = Number(input.sequence ?? rowNumber); delete input.sequence; const key = `${stageCode}|${String(input.taskName)}`; const existing = existingApprovalsByKey.get(key); const result = existing ? await updateProjectApproval(projectId, existing.id, input as never) : await createProjectApproval(projectId, input as never); if (result) existingApprovalsByKey.set(key, result) }
       else await createProjectPhase(projectId, input as never)
      successRows += 1
    } catch (error) { rowErrors.push({ row: rowNumber, message: error instanceof Error ? error.message : 'import_row_failed' }) }
  }
  const failedRows = rowErrors.filter(error => error.row !== undefined).length
   if (kind === 'tasks' && preview.rows.length && progressContext?.weekStart && progressContext.weekEnd) { const project = await getProject(projectId); const progressValues = preview.rows.map(row => Number(row.progress ?? 0)).filter(value => Number.isFinite(value)); const overallProgress = progressValues.length ? Math.round(progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length) : project?.progress ?? 0; const metadata = project?.metadata ?? {}; const history = Array.isArray(metadata.progressHistory) ? metadata.progressHistory.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object')).slice(-11) : []; const weekKey = progressContext?.weekStart && progressContext?.weekEnd ? `${progressContext.weekStart}/${progressContext.weekEnd}` : new Date().toISOString().slice(0,10); const previous = history.find(item => item.weekKey === weekKey); if (!previous) history.push({ value: project?.progress ?? 0, recordedAt: new Date().toISOString(), source: sourceName, weekKey }); await updateProject(projectId, { progress: overallProgress, metadata: { ...metadata, progressHistory: history } }) }
  const [updated] = await db.update(importJobs).set({ status: failedRows ? 'failed' : 'completed', totalRows: preview.totalRows, successRows, failedRows, errors: rowErrors, updatedAt: new Date() }).where(eq(importJobs.id, job.id)).returning()
  const knowledge = kind === 'tasks' && preview.rows.length ? await archiveAndIndexImplementationPlan(projectId, sourceName, body, '任务模块导入') : undefined
  if (kind === 'tasks' && /\.(xlsx|xlsm)$/i.test(sourceName)) {
    const weeklyCompletionText = await extractWeeklyCompletionText(body)
    if (weeklyCompletionText) {
      const latestProject = await getProject(projectId)
      await updateProject(projectId, { metadata: { ...(latestProject?.metadata ?? {}), latestWeeklyCompletion: { text: weeklyCompletionText, sourceName, importedAt: new Date().toISOString() } } })
    }
  }
  return { ...updated, knowledge }
}

export async function executeTaskSnapshotImport(projectId: string, sourceName: string, body: Buffer, preview: ImportPreview, jobId: string, progressContext?: { weekStart?: string; weekEnd?: string }, processKnowledge = true) {
  const errors = [...preview.errors]
  const seen = new Map<string, number>()
  for (const row of preview.rows) {
    const rowNumber = Number(row.__sourceRow) || 0
    let wbsCode = String(row.wbsCode ?? '').trim()
    if (seen.has(wbsCode)) {
      wbsCode = `${wbsCode}-R${rowNumber}`
      row.wbsCode = wbsCode
    } else seen.set(wbsCode, rowNumber)
    const progress = Number(row.progress ?? 0)
    const phaseName = String(row.phaseName ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ')
    if (!phaseName || ['/', '-', '—', '无', '未填写'].includes(phaseName)) errors.push({ row: rowNumber, message: 'import_task_phase_required' })
    if (row.status === 'completed' && progress !== 100) row.progress = '100'
    if (progress === 100 && !['completed', 'closed', 'cancelled'].includes(String(row.status))) row.status = 'completed'
    if (row.plannedStartDate && row.plannedEndDate && row.plannedStartDate > row.plannedEndDate) errors.push({ row: rowNumber, message: 'task_date_range_invalid' })
  }
  if (!preview.rows.length && !errors.length) errors.push({ message: 'import_task_snapshot_empty' })
  if (errors.length) {
    const [failed] = await db.update(importJobs).set({ status: 'failed', totalRows: preview.totalRows, successRows: 0, failedRows: errors.filter(error => error.row !== undefined).length || preview.totalRows, errors, updatedAt: new Date() }).where(eq(importJobs.id, jobId)).returning()
    return failed
  }

  const now = new Date()
  let result: { completed: typeof importJobs.$inferSelect; inserted: number; updated: number; archived: number }
  try {
    result = await db.transaction(async tx => {
      await tx.execute(sql`select ${projects.id} from ${projects} where ${projects.id} = ${projectId} for update`)
      const projectRows = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1)
      const project = projectRows[0]
      if (!project) throw new Error('project_not_found')
      const phaseRows = await tx.select().from(projectPhases).where(eq(projectPhases.projectId, projectId)).orderBy(asc(projectPhases.createdAt))
      const taskRows = await tx.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(desc(tasks.updatedAt))
      const normalizeName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
      const phasesByName = new Map<string, typeof phaseRows[number]>()
      for (const phase of [...phaseRows].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent))) if (!phasesByName.has(normalizeName(phase.name))) phasesByName.set(normalizeName(phase.name), phase)
      const currentPhaseIds = new Set<string>()
      const phaseIdByName = new Map<string, string>()
      const moduleNames = [...new Map(preview.rows.map(row => String(row.phaseName ?? '').trim()).filter(Boolean).map(name => [normalizeName(name), name])).values()]
      for (const [index, name] of moduleNames.entries()) {
        const key = normalizeName(name)
        const existing = phasesByName.get(key)
        if (existing) {
          await tx.update(projectPhases).set({ name: name.trim(), isCurrent: true, snapshotId: jobId, archivedAt: null, sortOrder: index, updatedAt: now }).where(eq(projectPhases.id, existing.id))
          currentPhaseIds.add(existing.id); phaseIdByName.set(key, existing.id)
        } else {
          const code = `IMP-${jobId.slice(0, 8)}-${String(index + 1).padStart(2, '0')}`
          const [created] = await tx.insert(projectPhases).values({ projectId, name: name.trim(), code, sortOrder: index, status: 'not_started', progress: 0, isCurrent: true, snapshotId: jobId, archivedAt: null }).returning()
          currentPhaseIds.add(created.id); phaseIdByName.set(key, created.id)
        }
      }
      const phasesToArchive = phaseRows.filter(phase => phase.isCurrent && !currentPhaseIds.has(phase.id)).map(phase => phase.id)
      if (phasesToArchive.length) await tx.update(projectPhases).set({ isCurrent: false, archivedAt: now, updatedAt: now }).where(inArray(projectPhases.id, phasesToArchive))

      const tasksByWbs = new Map<string, typeof taskRows[number]>()
      for (const task of [...taskRows].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.updatedAt.getTime() - a.updatedAt.getTime())) if (!tasksByWbs.has(task.wbsCode)) tasksByWbs.set(task.wbsCode, task)
      const currentWbs = new Set<string>()
      const taskIdByWbs = new Map<string, string>()
      let inserted = 0
      let updated = 0
      for (const row of preview.rows) {
        const wbsCode = String(row.wbsCode).trim()
        const phaseId = phaseIdByName.get(normalizeName(String(row.phaseName ?? ''))) ?? null
        const values = {
          phaseId, parentId: null, wbsCode, name: String(row.name).trim(), description: nullableImport(row.description), vendor: nullableImport(row.vendor), ownerName: nullableImport(row.ownerName), status: String(row.status || 'not_started') as typeof tasks.$inferInsert.status, priority: String(row.priority || 'medium') as typeof tasks.$inferInsert.priority, progress: Number(row.progress ?? 0), plannedStartDate: nullableImport(row.plannedStartDate), plannedEndDate: nullableImport(row.plannedEndDate), actualStartDate: nullableImport(row.actualStartDate), actualEndDate: nullableImport(row.actualEndDate), deliverable: nullableImport(row.deliverable), isCurrent: true, snapshotId: jobId, archivedAt: null, updatedAt: now,
        }
        const existing = tasksByWbs.get(wbsCode)
        if (existing) { await tx.update(tasks).set(values).where(eq(tasks.id, existing.id)); taskIdByWbs.set(wbsCode, existing.id); updated += 1 }
        else { const [created] = await tx.insert(tasks).values({ projectId, ...values }).returning({ id: tasks.id }); taskIdByWbs.set(wbsCode, created.id); inserted += 1 }
        currentWbs.add(wbsCode)
      }
      for (const [wbsCode, taskId] of taskIdByWbs) {
        const parts = wbsCode.split('.')
        let parentId: string | null = null
        while (parts.length > 1 && !parentId) { parts.pop(); parentId = taskIdByWbs.get(parts.join('.')) ?? null }
        await tx.update(tasks).set({ parentId }).where(eq(tasks.id, taskId))
      }
      const archivedIds = taskRows.filter(task => task.isCurrent && !currentWbs.has(task.wbsCode)).map(task => task.id)
      if (archivedIds.length) await tx.update(tasks).set({ isCurrent: false, archivedAt: now, updatedAt: now }).where(inArray(tasks.id, archivedIds))

      const moduleProgresses = [...new Map(moduleNames.map(name => [normalizeName(name), name])).keys()].map(key => {
        const moduleRows = preview.rows.filter(row => normalizeName(String(row.phaseName ?? '')) === key)
        const progress = Math.round(moduleRows.reduce((sum, row) => sum + Number(row.progress ?? 0), 0) / moduleRows.length)
        const statuses = new Set(moduleRows.map(row => String(row.status)))
        const status = progress === 100 ? 'completed' : statuses.has('blocked') ? 'blocked' : statuses.has('delayed') ? 'delayed' : progress === 0 ? 'not_started' : 'in_progress'
        return { key, progress, status }
      })
      for (const module of moduleProgresses) {
        const phaseId = phaseIdByName.get(module.key)
        if (phaseId) await tx.update(projectPhases).set({ progress: module.progress, status: module.status as typeof projectPhases.$inferInsert.status, updatedAt: now }).where(eq(projectPhases.id, phaseId))
      }
      const overallProgress = Math.round(moduleProgresses.reduce((sum, module) => sum + module.progress, 0) / moduleProgresses.length)
      const metadata = project.metadata ?? {}
      const history = Array.isArray(metadata.progressHistory) ? metadata.progressHistory.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object')).slice(-11) : []
      if (progressContext?.weekStart && progressContext.weekEnd) {
        const weekKey = `${progressContext.weekStart}/${progressContext.weekEnd}`
        if (!history.some(item => item.weekKey === weekKey)) history.push({ value: project.progress, recordedAt: now.toISOString(), source: sourceName, weekKey })
      }
      await tx.update(projects).set({ progress: overallProgress, metadata: { ...metadata, progressHistory: history, currentTaskSnapshotId: jobId, currentTaskSnapshotSource: sourceName, currentTaskSnapshotAt: now.toISOString() }, updatedAt: now }).where(eq(projects.id, projectId))
      await tx.insert(auditLogs).values({ projectId, entityType: 'task_snapshot', entityId: jobId, action: 'activated', actorName: 'system', changes: { sourceName, total: preview.rows.length, inserted, updated, archived: archivedIds.length, modules: moduleNames.length, summary: `切换当前实施计划快照：${sourceName}` } })
      const [completed] = await tx.update(importJobs).set({ status: 'completed', totalRows: preview.totalRows, successRows: preview.rows.length, failedRows: 0, errors: [], updatedAt: now }).where(eq(importJobs.id, jobId)).returning()
      return { completed, inserted, updated, archived: archivedIds.length }
    })
  } catch (error) {
    const failure = { message: error instanceof Error ? error.message : 'import_task_snapshot_failed' }
    const [failed] = await db.update(importJobs).set({ status: 'failed', totalRows: preview.totalRows, successRows: 0, failedRows: preview.totalRows, errors: [failure], updatedAt: new Date() }).where(eq(importJobs.id, jobId)).returning()
    return failed
  }
  let knowledge: unknown
  let knowledgeError: string | undefined
  if (processKnowledge) {
    try { knowledge = await archiveAndIndexImplementationPlan(projectId, sourceName, body, '任务模块导入') }
    catch (error) { knowledgeError = error instanceof Error ? error.message : 'implementation_plan_archive_failed' }
  }
  try {
    const weeklyCompletionText = processKnowledge && /\.(xlsx|xlsm)$/i.test(sourceName) ? await extractWeeklyCompletionText(body) : ''
    if (weeklyCompletionText) {
      const project = await getProject(projectId)
      await updateProject(projectId, { metadata: { ...(project?.metadata ?? {}), latestWeeklyCompletion: { text: weeklyCompletionText, sourceName, importedAt: new Date().toISOString() } } })
    }
  } catch { /* 周完成情况提取失败不回滚已确认的任务快照 */ }
  return { ...result.completed, knowledge, knowledgeError, snapshot: { inserted: result.inserted, updated: result.updated, archived: result.archived } }
}

function nullableImport(value: unknown) { return value === undefined || value === null || value === '' ? null : String(value) }

export async function previewWeeklyBatchImport(files: BatchImportFile[]) {
  const allProjects = await listProjects(false)
  return Promise.all(files.map(async file => {
    try {
      const projectKey = await detectWorkbookProject(file.body)
      const normalized = normalizeProjectKey(projectKey)
      const matches = allProjects.filter(item => normalizeProjectKey(item.name) === normalized || normalizeProjectKey(item.code) === normalized)
      return { fileName: file.fileName, projectKey, matchedProject: matches.length === 1 ? { id: matches[0]!.id, name: matches[0]!.name, code: matches[0]!.code } : null, projects: allProjects.map(item => ({ id: item.id, name: item.name, code: item.code })) }
    } catch (error) { return { fileName: file.fileName, projectKey: '', matchedProject: null, projects: allProjects.map(item => ({ id: item.id, name: item.name, code: item.code })), error: error instanceof Error ? error.message : 'import_preview_failed' } }
  }))
}

export async function executeWeeklyBatchImport(files: BatchImportFile[], weekStart: string, weekEnd: string, bindings: Record<string, string> = {}, autoCreate = true, confirmNameChanges = false) {
  if (!isDate(weekStart) || !isDate(weekEnd) || weekStart > weekEnd) throw new Error('import_week_range_invalid')
  let allProjects = await listProjects(false)
  const results: Array<Record<string, unknown>> = []
  for (const file of files) {
    try {
      if (!/\.(xlsx|xlsm)$/i.test(file.fileName)) throw new Error('import_format_unsupported')
      const projectKey = await detectWorkbookProject(file.body)
      const normalized = normalizeProjectKey(projectKey)
      const boundId = bindings[file.fileName]
      const project = boundId ? allProjects.find(item => item.id === boundId) : allProjects.find(item => normalizeProjectKey(item.name) === normalized || normalizeProjectKey(item.code) === normalized)
      let selectedProject = project
      if (!selectedProject && autoCreate && projectKey && !isPlaceholderProjectName(projectKey)) {
        const code = await nextProjectCode(allProjects)
        selectedProject = await createProject({ code, name: projectKey, status: 'planning', health: 'healthy', progress: 0 })
        allProjects = [...allProjects, selectedProject]
      }
      if (!selectedProject) throw new Error(projectKey ? `import_project_not_matched:${projectKey}` : 'import_project_name_not_found')
      const nameChanged = Boolean(projectKey && boundId && normalizeProjectKey(selectedProject.name) !== normalized)
      if (nameChanged && !confirmNameChanges) {
        results.push({ fileName: file.fileName, projectId: selectedProject.id, projectName: selectedProject.name, proposedProjectName: projectKey, status: 'name_change_confirmation_required', errors: [{ message: `project_name_change_confirmation:${selectedProject.name}->${projectKey}` }] })
        continue
      }
      if (nameChanged && projectKey) selectedProject = await updateProject(selectedProject.id, { name: projectKey }) ?? selectedProject
      const jobs = []
      const existingRisks = new Map((await listProjectRisks(selectedProject.id, { includeClosed: 'true' })).map(item => [item.code, item]))
      const existingMilestones = new Map((await listProjectMilestones(selectedProject.id, {})).map(item => [`${item.name}|${item.plannedDate}`, item]))
      let taskJob: Record<string, unknown>
      try { taskJob = await executeImport(selectedProject.id, 'tasks', file.fileName, file.body, { weekStart, weekEnd }); jobs.push(taskJob) }
      catch (error) { taskJob = { kind: 'tasks', status: 'failed', errors: [{ message: error instanceof Error ? error.message : 'import_failed' }] }; jobs.push(taskJob) }
      if (taskJob.status !== 'completed') {
        results.push({ fileName: file.fileName, projectId: selectedProject.id, projectName: selectedProject.name, projectCode: selectedProject.code, status: 'failed', jobs, errors: taskJob.errors ?? [{ message: 'import_task_snapshot_failed' }] })
        continue
      }
      for (const kind of ['risks', 'milestones', 'approvals', 'coordination'] as const) {
        try { jobs.push(await executeImport(selectedProject.id, kind, file.fileName, file.body, { weekStart, weekEnd })) }
        catch (error) { jobs.push({ kind, status: 'failed', errors: [{ message: error instanceof Error ? error.message : 'import_failed' }] }) }
      }
      const knowledge = taskJob.knowledge
      const weeklyCompletionText = await extractWeeklyCompletionText(file.body)
      if (weeklyCompletionText) {
        const latestProject = await getProject(selectedProject.id)
        await updateProject(selectedProject.id, { metadata: { ...(latestProject?.metadata ?? {}), latestWeeklyCompletion: { text: weeklyCompletionText, sourceName: file.fileName, weekStart, weekEnd, importedAt: new Date().toISOString() } } })
      }
      results.push({ fileName: file.fileName, projectId: selectedProject.id, projectName: selectedProject.name, weekStart, weekEnd, jobs, knowledge })
    } catch (error) {
      results.push({ fileName: file.fileName, weekStart, weekEnd, status: 'failed', errors: [{ message: error instanceof Error ? error.message : 'import_failed' }] })
    }
  }
  const fileFailed = (item: Record<string, unknown>) => !Array.isArray(item.jobs) || (item.jobs as Array<Record<string, unknown>>).some(job => job.status === 'failed' || Number(job.failedRows ?? 0) > 0 || (Array.isArray(job.errors) && job.errors.length > 0))
  return { weekStart, weekEnd, totalFiles: files.length, successFiles: results.filter(item => !fileFailed(item)).length, failedFiles: results.filter(fileFailed).length, results }
}

export async function extractWeeklyCompletionText(body: Buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(body as unknown as ExcelJS.Buffer)
  const sheet = workbook.getWorksheet('下周工作计划') ?? workbook.worksheets.find(item => item.name.includes('下周工作计划'))
  if (!sheet) return ''
  const lines: string[] = []
  let collecting = false
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = Array.from(new Set(Array.from({ length: Math.min(sheet.columnCount, 20) }, (_, index) => cellToImportText(sheet.getRow(rowNumber).getCell(index + 1).value).trim()).filter(Boolean)))
    const line = values.join(' ').trim()
    if (!line) continue
    if (/本周工作完成情况说明/.test(line)) { collecting = true; const remainder = line.replace(/^.*?本周工作完成情况说明[：:]?\s*/, '').trim(); if (remainder) lines.push(remainder); continue }
    if (collecting && /^(下周工作计划|下周计划|需协调|风险|备注)(?:[（(：:].*)?$/.test(line)) break
    if (collecting) lines.push(line)
  }
  return lines.join('\n').trim().slice(0, 12000)
}

async function detectWorkbookProject(body: Buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(body as unknown as ExcelJS.Buffer)
  for (const sheet of workbook.worksheets) {
    for (let rowNumber = 1; rowNumber <= Math.min(30, sheet.rowCount); rowNumber += 1) {
      const values = Array.from({ length: Math.min(sheet.columnCount, 20) }, (_, index) => cellToImportText(sheet.getRow(rowNumber).getCell(index + 1).value).trim())
      for (let index = 0; index < values.length; index += 1) {
        if (!/^(项目名称|项目名)[：:]?$/.test(values[index] ?? '')) continue
        const value = values.slice(index + 1).find(Boolean)
        if (value) return value
      }
    }
  }
  return ''
}
async function archiveAndIndexImplementationPlan(projectId: string, sourceName: string, body: Buffer, source: string) {
  const document = await createProjectProcessDocument(projectId, 'implementation-plan', { fileName: sourceName, body, fields: { name: sourceName.replace(/\.[^.]+$/, ''), status: 'confirmed', changeSummary: `${source}：保存原始项目计划实施表` } })
  const indexed = await parseAndIndexProjectDocument(projectId, document.id)
  return { documentId: indexed.documentId, versionId: indexed.versionId, parsed: indexed.parsed, embedded: indexed.embedded, wiki: indexed.wiki, warnings: indexed.warnings }
}
function normalizeProjectKey(value: string) { return value.replace(/[“”‘’"'\s]/g, '').trim().toLowerCase() }
function isPlaceholderProjectName(value: string) { return /^(某项目名称|项目名称|项目名|某项目)([-_：: ]|$)/.test(value.trim()) }
async function nextProjectCode(existing: Array<{ code: string }>) { const numbers = existing.map(item => /^P-(\d+)$/.exec(item.code)?.[1]).filter(Boolean).map(Number); return `P-${String(Math.max(0, ...numbers) + 1).padStart(3, '0')}` }

export async function executeTaskImport(projectId: string, kind: string, sourceName: string, body: Buffer) {
  if (kind !== 'tasks') throw new Error('import_kind_unsupported')
  return executeImport(projectId, kind, sourceName, body)
}

function assertSupportedFormat(kind: string, sourceName: string) {
  if (kind !== 'tasks' && kind !== 'risks' && kind !== 'milestones' && kind !== 'phases' && kind !== 'coordination' && kind !== 'approvals') throw new Error('import_kind_unsupported')
  if (!/\.(csv|xlsx|xlsm)$/i.test(sourceName)) throw new Error('import_format_unsupported')
}

async function parseImportRows(kind: string, sourceName: string, body: Buffer): Promise<{ headers: string[]; rows: ImportRow[] }> {
  if (/\.csv$/i.test(sourceName)) {
    const records = parse(body.toString('utf8'), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true, on_record: (record: ImportRow, context: { lines: number }) => ({ ...record, __sourceRow: String(context.lines) }) }) as ImportRow[]
    return { headers: records.length ? Object.keys(records[0]!).filter(header => header !== '__sourceRow') : parseHeaders(body), rows: records }
  }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(body as unknown as ExcelJS.Buffer)
  const preferredNames = templateSheetNames[kind] ?? []
  const sheet = preferredNames.map(name => workbook.getWorksheet(name)).find(Boolean)
    ?? (kind === 'coordination' ? workbook.worksheets.find(item => /协调事项跟进/.test(item.name)) : undefined)
    ?? workbook.worksheets[0]
  if (!sheet) return { headers: [], rows: [] }
  const aliases: Record<string, string> = sheet.name === 'WBS范围分解' && kind === 'tasks'
    ? { 'WBS编号': 'wbsCode', '系统域': 'phaseName', '工作包': 'moduleName', '承建方': 'vendor', '一级模块': 'moduleName', '二级模块': 'name', '交付物/范围说明': 'deliverable', '交付节点': 'plannedEndDate' }
    : sheet.name === '关键里程碑计划' && kind === 'milestones'
      ? { '序号': 'sequence', '里程碑': 'name', '计划日期': 'plannedDate', '交付内容': 'deliverable', '责任方': 'ownerName', '类型': 'type', '当前状态': 'status' }
      : sheet.name === '风险与依赖管控' && kind === 'risks'
        ? { '序号': 'sequence', '风险等级': 'level', '风险项': 'name', '风险描述与影响': 'description', '应对措施': 'mitigation', '责任人': 'ownerName' }
        : headerAliases[kind] ?? {}
  let headerRow = 0
  let headers: string[] = []
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (headerRow) return
    const cells = Array.from({ length: sheet.columnCount }, (_, index) => cellToImportText(row.getCell(index + 1).value).trim().replace(/[\t*★]/g, '').trim())
    const mapped = cells.map(value => aliases[value] ?? value)
    const recognized = mapped.filter(value => Object.values(aliases).includes(value)).length
    if (recognized >= Math.min(2, Math.max(1, Object.values(aliases).length))) { headerRow = rowNumber; headers = mapped }
  })
  if (!headerRow) throw new Error('import_header_not_found')
  const rows: ImportRow[] = []
  const referenceDate = inferWorkbookReferenceDate(workbook, sourceName)
  let previousApprovalStage = ''
  let previousTaskPhase = ''
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const result: ImportRow = {}
    headers.forEach((header, index) => { if (header) result[header] = cellToImportText(row.getCell(index + 1).value).trim() })
     if (kind === 'tasks') {
       const phase = String(result.phaseName ?? '').normalize('NFKC').trim()
       const missingPhase = !phase || ['/', '-', '—', '无', '未填写'].includes(phase)
       if (missingPhase) result.phaseName = previousTaskPhase || '未分组'
       else previousTaskPhase = phase
     }
    if (!Object.values(result).some(value => value !== '')) continue
     if (kind === 'approvals' && !result.stageName && previousApprovalStage) result.stageName = previousApprovalStage
     if (kind === 'approvals' && result.stageName && previousApprovalStage && !result.taskName) result.stageName = previousApprovalStage
     if (kind === 'approvals' && result.stageName) previousApprovalStage = result.stageName
    const normalized = normalizeTemplateRow(kind, result, rowNumber, referenceDate)
    if (normalized) {
      // ICT-1 keeps an explicitly supplied blank task cell as ''. The change engine
      // distinguishes it from a column absent from the uploaded template.
      if (kind === 'tasks') for (const header of headers.filter(Boolean)) if (taskHeaders.has(header) && !(header in normalized)) normalized[header] = ''
      rows.push({ ...normalized, __sourceRow: String(rowNumber) })
    }
  }
  const outputHeaders = [...new Set(rows.flatMap(row => Object.keys(row)).filter(header => header !== '__sourceRow'))]
  return { headers: outputHeaders, rows }
}

function normalizeTemplateRow(kind: string, row: ImportRow, rowNumber: number, referenceDate = new Date()): ImportRow | undefined {
  const compact = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '')) as ImportRow
  if (kind === 'tasks') {
    if (!compact.name) return undefined
    // A named task without a WBS code is still an importable row. Keep the
    // generated key stable for the same source row across repeated imports.
    if (!compact.wbsCode) compact.wbsCode = `AUTO-${rowNumber}`
    compact.progress = normalizeProgress(compact.progress)
    compact.status = normalizeTaskStatus(compact.status, compact.progress)
    if (compact.status === 'completed' && Number(compact.progress) === 0) compact.progress = '100'
    compact.priority = normalizePriority(compact.priority)
    compact.plannedStartDate = normalizeDate(compact.plannedStartDate)
    compact.plannedEndDate = normalizeDate(compact.plannedEndDate)
     if (compact.plannedStartDate && compact.plannedEndDate && compact.plannedStartDate > compact.plannedEndDate) { const start = compact.plannedStartDate; compact.plannedStartDate = compact.plannedEndDate; compact.plannedEndDate = start }
    const description = [compact.moduleName ? `二级模块：${compact.moduleName}` : '', compact.thirdModuleName ? `三级模块：${compact.thirdModuleName}` : '', compact.delayReason && compact.delayReason !== '无' ? `延期原因及措施：${compact.delayReason}` : ''].filter(Boolean).join('\n')
    if (description) compact.description = description
    delete compact.moduleName; delete compact.thirdModuleName; delete compact.delayReason
  } else if (kind === 'risks') {
    if (!compact.name) return undefined
    compact.code = compact.code || `R-${String(compact.sequence || rowNumber).padStart(3, '0')}`
    compact.level = normalizeRiskLevel(compact.level, compact.impactLevel, compact.probability)
    compact.status = normalizeRiskStatus(compact.status)
    compact.expectedResolutionDate = normalizeDate(compact.expectedResolutionDate); if (!compact.expectedResolutionDate) compact.expectedResolutionDate = ''
    compact.description = compact.description || compact.name
    if (compact.impactLevel || compact.probability) compact.impact = `影响程度：${compact.impactLevel || '未填写'}；发生概率：${compact.probability || '未填写'}`
    delete compact.sequence; delete compact.impactLevel; delete compact.probability
  } else if (kind === 'milestones') {
    if (!compact.name || !compact.plannedDate) return undefined
    compact.plannedDate = normalizeDate(compact.plannedDate)
    if (!compact.plannedDate) return undefined
    compact.type = 'key'; compact.status = normalizeMilestoneStatus(compact.status); const actual = compact.actualDate?.trim(); compact.actualDate = !actual || ['未完成','未完成。','/','—','-'].includes(actual) ? '' : normalizeDate(actual)
    if (compact.startDate) compact.description = `计划开始：${normalizeDate(compact.startDate)}`
    delete compact.sequence; delete compact.startDate
  } else if (kind === 'coordination') {
    if (!compact.title) return undefined
    compact.code = compact.code || `C-${String(compact.sequence || rowNumber).padStart(3, '0')}`
    compact.category = compact.category || '项目协调'
    compact.priority = normalizePriority(compact.priority)
    const expected = parseCoordinationExpectedTime(compact.expectedResolutionText, referenceDate)
    const directDueDate = parseCoordinationExpectedTime(compact.dueDate, referenceDate).dueDate || ''
    const directResolution = parseCoordinationExpectedTime(compact.resolvedAt, referenceDate)
    const directResolvedAt = directResolution.resolvedAt || directResolution.dueDate || ''
    const explicitStatus = compact.status ? normalizeCoordinationStatus(compact.status) : ''
    const terminal = (status: string | undefined) => status === 'resolved' || status === 'closed'
    compact.status = terminal(explicitStatus) ? explicitStatus : terminal(expected.status) ? expected.status! : terminal(directResolution.status) ? directResolution.status! : directResolvedAt ? 'resolved' : explicitStatus || expected.status || 'to_start'
    compact.progress = terminal(compact.status) ? '100' : normalizeProgress(compact.progress)
    compact.dueDate = expected.dueDate || directDueDate
    compact.resolvedAt = terminal(compact.status) ? directResolvedAt || expected.resolvedAt || '' : ''
    const expectedNote = expected.raw ? `期望解决时间原文：${expected.raw}` : ''
    compact.description = [compact.impactText ? `影响：${compact.impactText}` : '', compact.explanationText ? `说明：${compact.explanationText}` : '', compact.description, compact.supportRequired ? `需支持/决策：${compact.supportRequired}` : '', expectedNote].filter(Boolean).join('\n')
    delete compact.sequence; delete compact.supportRequired; delete compact.expectedResolutionText; delete compact.impactText; delete compact.explanationText
  } else if (kind === 'approvals') {
     if (!compact.stageName || !compact.taskName) return undefined
     compact.status = normalizeApprovalStatus(compact.status)
     for (const key of ['plannedStartDate','plannedEndDate','actualStartDate','actualEndDate'] as const) compact[key] = normalizeDate(compact[key])
     compact.sequence = compact.sequence || String(rowNumber)
  } else if (kind === 'phases') {
    if (!compact.name) return undefined
    compact.code = compact.code || `P${rowNumber}`; compact.status = 'not_started'; compact.progress = '0'
  }
  return Object.fromEntries(Object.entries(compact).filter(([, value]) => value !== ''))
}

function inferWorkbookReferenceDate(workbook: ExcelJS.Workbook, sourceName: string) {
  const years = new Map<number, number>()
  for (const sheet of workbook.worksheets) sheet.eachRow({ includeEmpty: false }, row => row.eachCell(cell => {
    if (cell.value instanceof Date) years.set(cell.value.getFullYear(), (years.get(cell.value.getFullYear()) ?? 0) + 1)
    for (const match of String(cell.value == null ? '' : cell.text ?? '').matchAll(/\b(20\d{2})\b/g)) { const year = Number(match[1]); years.set(year, (years.get(year) ?? 0) + 1) }
  }))
  const fileYear = /(?:^|\D)(20\d{2})(?:\D|$)/.exec(sourceName)?.[1]
  if (fileYear) years.set(Number(fileYear), (years.get(Number(fileYear)) ?? 0) + 1)
  const year = [...years.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? new Date().getFullYear()
  return new Date(Date.UTC(year, 0, 1))
}

function normalizeProgress(value = '') { const text = value.trim(); if (!text) return '0'; const hasPercentUnit = /%|百分之/.test(text); const cleaned = text.replace(/百分之/g, '').replace('%', '').trim(); const numeric = Number(cleaned); if (!Number.isFinite(numeric)) return '0'; const normalized = !hasPercentUnit && numeric > 0 && numeric <= 1 ? numeric * 100 : numeric; return String(Math.max(0, Math.min(100, normalized))) }
function normalizeTaskStatus(value = '', progress = '0') { const map: Record<string,string> = { '未开始':'not_started','未启动':'not_started','待开始':'not_started','待启动':'ready','待完成':'in_progress','进行中':'in_progress','已延期':'delayed','延期':'delayed','已完成':'completed','完成':'completed','关闭':'closed','已关闭':'closed','暂缓':'blocked','阻塞':'blocked' }; const clean = value.replace(/[（(].*?[）)]/g, '').replace(/[，,].*$/, '').replace(/[-/].*$/, '').trim(); const mapped = (map[clean] ?? map[value] ?? value) || 'not_started'; const result = Number(progress) === 100 && ['not_started','ready','in_progress','delayed'].includes(mapped) ? 'completed' : mapped; return taskStatuses.has(result) ? result : 'not_started' }
function normalizePriority(value = '') { const map: Record<string,string> = { '低':'low','中':'medium','高':'high','关键':'critical','严重':'critical','P0':'critical','P1':'high','P2':'medium' }; const result = (map[value.toUpperCase()] ?? map[value] ?? value) || 'medium'; return taskPriorities.has(result) ? result : 'medium' }
function normalizeRiskLevel(value = '', impact = '', probability = '') { const map: Record<string,string> = { '低':'low','中':'medium','高':'high','严重':'critical','关键':'critical' }; const result = (map[value] ?? map[impact] ?? map[probability] ?? value) || 'medium'; return riskLevels.has(result) ? result : 'medium' }
function normalizeRiskStatus(value = '') { const map: Record<string,string> = { '待处理':'identified','已识别':'identified','跟进中':'following','处理中':'following','已缓解':'mitigated','已关闭':'closed','已接受':'accepted' }; const clean = value.replace(/[（(].*?[）)]/g, '').trim(); const result = (map[clean] ?? map[value] ?? value) || 'identified'; return riskStatuses.has(result) ? result : 'identified' }
function normalizeMilestoneStatus(value = '') { const map: Record<string,string> = { '未开始':'not_started','未启动':'not_started','进行中':'in_progress','已延期':'delayed','延期':'delayed','已完成':'completed','完成':'completed','已取消':'cancelled' }; const result = (map[value] ?? value) || 'not_started'; return milestoneStatuses.has(result) ? result : 'not_started' }
function approvalStageCode(stageName: string) { const value = stageName.trim(); if (/建议书/.test(value)) return 's1'; if (/初设|可研|审批|设计|评审/.test(value)) return 's2'; if (/采购|招标|投标/.test(value)) return 's3'; if (/合同|主合同/.test(value)) return 's4'; return `approval-${value.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 24) || 'other'}` }
function normalizeApprovalStatus(value = '') { const map: Record<string,string> = { '未开始':'not_started','未启动':'not_started','进行中':'in_progress','已完成':'completed','完成':'completed','已关闭':'closed','关闭':'closed','已取消':'cancelled','取消':'cancelled' }; const result = (map[value.trim()] ?? value.trim()) || 'not_started'; return phaseStatuses.has(result) ? result : 'not_started' }
function normalizeCoordinationStatus(value = '') { const map: Record<string,string> = { '待发起':'to_start','待处理':'to_start','未开始':'to_start','待评估':'to_start','待确认':'to_start','待定':'to_start','待明确':'to_start','待协调':'to_start','待推进':'to_start','沟通中':'communicating','处理中':'communicating','跟进中':'communicating','推进中':'communicating','进行中':'communicating','协调中':'communicating','持续推进':'communicating','持续跟进':'communicating','长期跟进':'communicating','已解决':'resolved','解决':'resolved','已完成':'resolved','完成':'resolved','处理完毕':'resolved','已关闭':'closed','关闭':'closed','已结项':'closed' }; const clean = value.normalize('NFKC').replace(/[（(].*?[）)]/g, '').trim(); const result = (map[clean] ?? value) || 'to_start'; return coordinationStatuses.has(result) ? result : 'to_start' }
function normalizeDate(value = '') { const text = value.trim(); if (!text || ['/', '—', '-', '未完成', '未完成。'].includes(text)) return ''; const serial = /^\+?(\d{5})(?:-(\d{1,2}))?$/.exec(text); if (serial) { const days = Number(serial[1]); const date = new Date(Date.UTC(1899, 11, 30) + days * 86400000); if (date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100) return date.toISOString().slice(0, 10) } const direct = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text); if (direct) { const year = Number(direct[1]), month = Number(direct[2]), day = Number(direct[3]); const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}` } const cn = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(text); if (cn) return normalizeDate(`${cn[1]}-${cn[2]}-${cn[3]}`); const parsed = new Date(text); return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10) }

function cellToImportText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && value >= 1 && value <= 100000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000)
    if (date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100) return date.toISOString().slice(0, 10)
  }
  if (typeof value !== 'object') return String(value)
  if ('richText' in value) return value.richText.map(item => item.text).join('')
  if ('formula' in value) return value.result === undefined ? `=${value.formula}` : cellToImportText(value.result as ExcelJS.CellValue)
  if ('hyperlink' in value) return value.text || value.hyperlink
  if ('error' in value) return value.error
  return JSON.stringify(value)
}

function validateTaskRow(row: ImportRow) {
  if (typeof row.wbsCode !== 'string' || !row.wbsCode.trim() || typeof row.name !== 'string' || !row.name.trim()) throw new Error('import_task_wbs_and_name_required')
  for (const key of Object.keys(row)) if (!taskHeaders.has(key) && !['phaseName'].includes(key)) throw new Error(`import_column_unsupported:${key}`)
  if (row.progress !== undefined && row.progress !== '' && (!Number.isFinite(Number(row.progress)) || Number(row.progress) < 0 || Number(row.progress) > 100)) throw new Error('task_progress_invalid')
}

function validateRiskRow(row: ImportRow) {
  if (typeof row.code !== 'string' || !row.code.trim() || typeof row.name !== 'string' || !row.name.trim()) throw new Error('import_risk_code_and_name_required')
  for (const key of Object.keys(row)) if (!riskHeaders.has(key)) throw new Error(`import_column_unsupported:${key}`)
  if (row.level && !riskLevels.has(row.level)) throw new Error('risk_level_invalid')
  if (row.status && !riskStatuses.has(row.status)) throw new Error('risk_status_invalid')
  for (const key of ['expectedResolutionDate', 'closedAt'] as const) if (row[key] && !isDate(row[key])) throw new Error(`risk_${key}_invalid`)
}

function validateCoordinationRow(row: ImportRow) {
  if (typeof row.code !== 'string' || !row.code.trim() || typeof row.title !== 'string' || !row.title.trim()) throw new Error('import_coordination_code_and_title_required')
  for (const key of Object.keys(row)) if (!coordinationHeaders.has(key)) throw new Error(`import_column_unsupported:${key}`)
  if (row.priority && !coordinationPriorities.has(row.priority)) throw new Error('coordination_priority_invalid')
  if (row.status && !coordinationStatuses.has(row.status)) throw new Error('coordination_status_invalid')
  if (row.dueDate && !isDate(row.dueDate)) throw new Error('coordination_dueDate_invalid')
}

function validateApprovalRow(row: ImportRow) { if (!row.stageName || !row.taskName) throw new Error('import_approval_stage_and_task_required'); if (row.status && !phaseStatuses.has(row.status)) throw new Error('approval_status_invalid'); for (const key of ['plannedStartDate','plannedEndDate','actualStartDate','actualEndDate'] as const) if (row[key] && !isDate(row[key])) throw new Error(`approval_${key}_invalid`) }

function validateMilestoneRow(row: ImportRow) {
  if (typeof row.name !== 'string' || !row.name.trim() || typeof row.plannedDate !== 'string' || !row.plannedDate.trim()) throw new Error('import_milestone_name_and_date_required')
  for (const key of Object.keys(row)) if (!milestoneHeaders.has(key)) throw new Error(`import_column_unsupported:${key}`)
  if (row.type && !milestoneTypes.has(row.type)) throw new Error('milestone_type_invalid')
  if (row.status && !milestoneStatuses.has(row.status)) throw new Error('milestone_status_invalid')
  if (!isDate(row.plannedDate)) throw new Error('milestone_date_invalid')
  if (row.actualDate && !isDate(row.actualDate)) throw new Error('milestone_actual_date_invalid')
}

function validatePhaseRow(row: ImportRow, unsupportedHeaders: string[] = []) {
  if (unsupportedHeaders.length) throw new Error(`import_column_unsupported:${unsupportedHeaders[0]}`)
  if (typeof row.name !== 'string' || !row.name.trim() || typeof row.code !== 'string' || !row.code.trim()) throw new Error('phase_name_and_code_required')
  if (row.status && !phaseStatuses.has(row.status)) throw new Error('phase_status_invalid')
  if (row.progress && (!Number.isFinite(Number(row.progress)) || Number(row.progress) < 0 || Number(row.progress) > 100)) throw new Error('phase_progress_invalid')
  if (row.plannedStartDate && !isDate(row.plannedStartDate)) throw new Error('phase_plannedStartDate_invalid')
  if (row.plannedEndDate && !isDate(row.plannedEndDate)) throw new Error('phase_plannedEndDate_invalid')
  if (row.plannedStartDate && row.plannedEndDate && row.plannedStartDate > row.plannedEndDate) throw new Error('phase_date_range_invalid')
  const status = row.status || 'not_started'
  const progress = row.progress === undefined || row.progress === '' ? 0 : Number(row.progress)
  if (status === 'completed' && progress !== 100) throw new Error('completed_phase_requires_100_progress')
  if (progress === 100 && !['completed', 'closed', 'cancelled'].includes(status)) throw new Error('100_progress_requires_completed_status')
}

function isDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value }
function parseHeaders(body: Buffer) { const line = body.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? ''; return line.split(',').map(value => value.trim()).filter(Boolean) }
async function assertProject(projectId: string) { const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1); if (!project) throw new Error('project_not_found') }
function assertUuid(value: string, code: string) { if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error(code) }
function validateText(value: string, code: string) { if (typeof value !== 'string' || !value.trim()) throw new Error(code) }

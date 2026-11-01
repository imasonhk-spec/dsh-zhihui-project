import { and, asc, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { projectPhases, projects, tasks } from '../../db/schema.ts'
import { recordAuditLog } from '../audit/audit-log.ts'

const terminalStatuses = new Set(['completed', 'closed', 'cancelled'])
const allowedStatuses = new Set(['not_started', 'ready', 'in_progress', 'delayed', 'completed', 'closed', 'cancelled', 'blocked'])
const allowedPriorities = new Set(['low', 'medium', 'high', 'critical'])
const allowedInputKeys = new Set(['wbsCode', 'name', 'description', 'phaseId', 'parentId', 'vendor', 'ownerName', 'status', 'priority', 'progress', 'plannedStartDate', 'plannedEndDate', 'actualStartDate', 'actualEndDate', 'deliverable'])

type TaskInput = {
  wbsCode: string
  name: string
  description?: string | null
  phaseId?: string | null
  parentId?: string | null
  vendor?: string | null
  ownerName?: string | null
  status?: string
  priority?: string
  progress?: number
  plannedStartDate?: string | null
  plannedEndDate?: string | null
  actualStartDate?: string | null
  actualEndDate?: string | null
  deliverable?: string | null
}

export async function listProjectTasks(projectId: string, filters: { q?: string; phaseId?: string; status?: string; priority?: string }) {
  await assertProject(projectId)
  await markOverdueTasks(projectId)
  validateFilters(filters)
  const conditions = [eq(tasks.projectId, projectId), eq(tasks.isCurrent, true)]
  if (filters.phaseId) conditions.push(eq(tasks.phaseId, filters.phaseId))
  if (filters.status) conditions.push(eq(tasks.status, filters.status as never))
  if (filters.priority) conditions.push(eq(tasks.priority, filters.priority as never))
  const rows = await db.select().from(tasks).where(and(...conditions)).orderBy(asc(tasks.wbsCode))
  const query = filters.q?.trim().toLowerCase()
  const filtered = query ? rows.filter(task => [task.wbsCode, task.name, task.ownerName ?? '', task.vendor ?? ''].some(value => value.toLowerCase().includes(query))) : rows
  return filtered.sort((a, b) => compareWbs(a.wbsCode, b.wbsCode))
}

export async function getProjectTask(projectId: string, taskId: string) {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), eq(tasks.isCurrent, true))).limit(1)
  return row
}

export async function createProjectTask(projectId: string, input: TaskInput) {
  await assertProject(projectId)
  validateTaskInput(input)
  if (input.parentId) await assertTask(projectId, input.parentId)
  if (input.phaseId) await assertPhase(projectId, input.phaseId)
  const initialStatus = input.status ?? 'not_started'
  const initialProgress = clampProgress(input.progress ?? 0)
  if (initialStatus === 'completed' && initialProgress !== 100) throw new Error('completed_task_requires_100_progress')
  if (initialProgress === 100 && !terminalStatuses.has(initialStatus)) throw new Error('100_progress_requires_completed_status')
  const [row] = await db.insert(tasks).values({ projectId, wbsCode: input.wbsCode.trim(), name: input.name.trim(), description: input.description ?? null, phaseId: input.phaseId ?? null, parentId: input.parentId ?? null, vendor: input.vendor ?? null, ownerName: input.ownerName ?? null, status: initialStatus as never, priority: (input.priority ?? 'medium') as never, progress: initialProgress, plannedStartDate: input.plannedStartDate ?? null, plannedEndDate: input.plannedEndDate ?? null, actualStartDate: input.actualStartDate ?? null, actualEndDate: input.actualEndDate ?? null, deliverable: input.deliverable ?? null }).returning()
  await recordAuditLog({ projectId, entityType: 'task', entityId: row.id, action: 'created', changes: { name: row.name, summary: `新增任务 ${row.wbsCode} ${row.name}` } })
  return row
}

export async function updateProjectTask(projectId: string, taskId: string, input: Partial<TaskInput>) {
  const existing = await getProjectTask(projectId, taskId)
  if (!existing) return undefined
  validateTaskInput(input, true)
  if (input.parentId) { if (input.parentId === taskId) throw new Error('task_parent_self'); await assertTask(projectId, input.parentId); await assertNoTaskCycle(projectId, taskId, input.parentId) }
  if (input.phaseId) await assertPhase(projectId, input.phaseId)
  const nextStatus = input.status ?? existing.status
  const nextProgress = input.progress === undefined ? existing.progress : clampProgress(input.progress)
  const nextStartDate = nullable(input.plannedStartDate === undefined ? existing.plannedStartDate : input.plannedStartDate)
  const nextEndDate = nullable(input.plannedEndDate === undefined ? existing.plannedEndDate : input.plannedEndDate)
  if (nextStartDate && nextEndDate && nextStartDate > nextEndDate) throw new Error('task_date_range_invalid')
  if (nextStatus === 'completed' && nextProgress !== 100) throw new Error('completed_task_requires_100_progress')
  if (nextProgress === 100 && !terminalStatuses.has(nextStatus)) throw new Error('100_progress_requires_completed_status')
  const changes: Record<string, unknown> = {}
  for (const key of ['wbsCode', 'name', 'status', 'priority', 'progress', 'plannedStartDate', 'plannedEndDate', 'ownerName', 'vendor', 'deliverable'] as const) {
    if (input[key] !== undefined && input[key] !== existing[key]) changes[key] = { from: existing[key], to: input[key] }
  }
  const updateValues = {
    ...(input.wbsCode === undefined ? {} : { wbsCode: input.wbsCode.trim() }),
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.description === undefined ? {} : { description: nullable(input.description) }),
    ...(input.phaseId === undefined ? {} : { phaseId: nullable(input.phaseId) }),
    ...(input.parentId === undefined ? {} : { parentId: nullable(input.parentId) }),
    ...(input.vendor === undefined ? {} : { vendor: nullable(input.vendor) }),
    ...(input.ownerName === undefined ? {} : { ownerName: nullable(input.ownerName) }),
    ...(input.status === undefined ? {} : { status: input.status as never }),
    ...(input.priority === undefined ? {} : { priority: input.priority as never }),
    progress: nextProgress,
    ...(input.plannedStartDate === undefined ? {} : { plannedStartDate: nextStartDate }),
    ...(input.plannedEndDate === undefined ? {} : { plannedEndDate: nextEndDate }),
    ...(input.actualStartDate === undefined ? {} : { actualStartDate: nullable(input.actualStartDate) }),
    ...(input.actualEndDate === undefined ? {} : { actualEndDate: nullable(input.actualEndDate) }),
    ...(input.deliverable === undefined ? {} : { deliverable: nullable(input.deliverable) }),
    ...(nextStatus === 'completed' && !existing.actualEndDate ? { actualEndDate: new Date().toISOString().slice(0, 10) } : {}),
    updatedAt: new Date(),
  }
  const [row] = await db.update(tasks).set(updateValues).where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId))).returning()
  if (Object.keys(changes).length) await recordAuditLog({ projectId, entityType: 'task', entityId: taskId, action: input.status && input.status !== existing.status ? 'status_changed' : input.progress !== undefined && input.progress !== existing.progress ? 'progress_changed' : 'updated', changes: { ...changes, name: row.name, summary: `更新任务 ${row.wbsCode} ${row.name}` } })
  return row
}

async function markOverdueTasks(projectId: string) {
  const today = new Date().toISOString().slice(0, 10)
  const rows = await db.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.isCurrent, true)))
  const overdue = rows.filter(task => task.status !== 'delayed' && !terminalStatuses.has(task.status) && task.plannedEndDate !== null && task.plannedEndDate < today)
  for (const task of overdue) {
    await db.update(tasks).set({ status: 'delayed', updatedAt: new Date() }).where(eq(tasks.id, task.id))
    await recordAuditLog({ projectId, entityType: 'task', entityId: task.id, action: 'status_changed', changes: { status: { from: task.status, to: 'delayed' }, name: task.name, summary: `任务 ${task.wbsCode} ${task.name} 已自动标记延期` } })
  }
}
async function assertNoTaskCycle(projectId: string, taskId: string, parentId: string) {
  let current: string | null = parentId
  const visited = new Set<string>()
  while (current) {
    if (current === taskId) throw new Error('task_parent_cycle')
    if (visited.has(current)) throw new Error('task_parent_cycle')
    visited.add(current)
    const parent: typeof tasks.$inferSelect | undefined = await getProjectTask(projectId, current)
    current = parent?.parentId ?? null
  }
}
async function assertProject(projectId: string) { const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1); if (!row) throw new Error('project_not_found') }
async function assertTask(projectId: string, taskId: string) { const row = await getProjectTask(projectId, taskId); if (!row) throw new Error('task_parent_not_found') }
async function assertPhase(projectId: string, phaseId: string) { const [row] = await db.select({ id: projectPhases.id }).from(projectPhases).where(and(eq(projectPhases.id, phaseId), eq(projectPhases.projectId, projectId), eq(projectPhases.isCurrent, true))).limit(1); if (!row) throw new Error('task_phase_not_found') }
function validateFilters(filters: { status?: string; priority?: string }) { if (filters.status && !allowedStatuses.has(filters.status)) throw new Error('task_status_invalid'); if (filters.priority && !allowedPriorities.has(filters.priority)) throw new Error('task_priority_invalid') }
function validateTaskInput(input: Partial<TaskInput>, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('task_body_invalid')
  for (const key of Object.keys(input)) if (!allowedInputKeys.has(key)) throw new Error('task_field_invalid')
  if (!partial && (typeof input.wbsCode !== 'string' || !input.wbsCode.trim() || typeof input.name !== 'string' || !input.name.trim())) throw new Error('task_wbs_and_name_required')
  if (input.wbsCode !== undefined && typeof input.wbsCode !== 'string') throw new Error('task_wbs_type_invalid')
  if (input.name !== undefined && typeof input.name !== 'string') throw new Error('task_name_type_invalid')
  if (input.status !== undefined && (typeof input.status !== 'string' || !allowedStatuses.has(input.status))) throw new Error('task_status_invalid')
  if (input.priority !== undefined && (typeof input.priority !== 'string' || !allowedPriorities.has(input.priority))) throw new Error('task_priority_invalid')
  if (input.progress !== undefined && (typeof input.progress !== 'number' || !Number.isFinite(input.progress) || input.progress < 0 || input.progress > 100)) throw new Error('task_progress_invalid')
  for (const key of ['description', 'phaseId', 'parentId', 'vendor', 'ownerName', 'plannedStartDate', 'plannedEndDate', 'actualStartDate', 'actualEndDate', 'deliverable'] as const) if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') throw new Error(`task_${key}_type_invalid`)
  if (input.plannedStartDate && input.plannedEndDate && input.plannedStartDate > input.plannedEndDate) throw new Error('task_date_range_invalid')
}
function compareWbs(a: string, b: string) { const left = a.split('.').map(Number); const right = b.split('.').map(Number); for (let i = 0; i < Math.max(left.length, right.length); i += 1) { const diff = (left[i] ?? -1) - (right[i] ?? -1); if (diff) return diff } return a.localeCompare(b) }
function nullable(value: string | null | undefined) { return value === null || value === undefined || value === '' ? null : value }
function clampProgress(progress: number) { if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error('task_progress_invalid'); return progress }

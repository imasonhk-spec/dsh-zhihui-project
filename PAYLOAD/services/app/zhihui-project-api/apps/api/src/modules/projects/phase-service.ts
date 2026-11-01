import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { projectPhases, projects, tasks, auditLogs } from '../../db/schema.ts'

export type PhaseStatus = 'not_started' | 'ready' | 'in_progress' | 'delayed' | 'completed' | 'closed' | 'cancelled' | 'blocked'
export type PhaseInput = {
  name: string
  code: string
  status?: PhaseStatus
  progress?: number
  plannedStartDate?: string | null
  plannedEndDate?: string | null
}
export type PhaseUpdateInput = Partial<PhaseInput>
export type PhaseReorderInput = { phaseIds: string[] }

const statuses = new Set<PhaseStatus>(['not_started', 'ready', 'in_progress', 'delayed', 'completed', 'closed', 'cancelled', 'blocked'])
const fields = new Set(['name', 'code', 'status', 'progress', 'plannedStartDate', 'plannedEndDate'])
const terminalStatuses = new Set<PhaseStatus>(['completed', 'closed', 'cancelled'])

export async function listProjectPhases(projectId: string) {
  await assertProject(projectId)
  return db.select().from(projectPhases).where(and(eq(projectPhases.projectId, projectId), eq(projectPhases.isCurrent, true))).orderBy(asc(projectPhases.sortOrder), asc(projectPhases.createdAt))
}

export async function createProjectPhase(projectId: string, input: PhaseInput) {
  await assertProject(projectId)
  validateInput(input)
  const status = input.status ?? 'not_started'
  const progress = input.progress ?? 0
  validateProgressStatus(progress, status)
  await validateProjectDates(projectId, input.plannedStartDate, input.plannedEndDate)
  try {
    return await db.transaction(async tx => {
      const [row] = await tx.insert(projectPhases).values({ projectId, name: input.name.trim(), code: input.code.trim(), status, progress, plannedStartDate: nullable(input.plannedStartDate), plannedEndDate: nullable(input.plannedEndDate) }).returning()
      await tx.insert(auditLogs).values({ projectId, entityType: 'phase', entityId: row.id, action: 'created', actorName: 'system', changes: { name: row.name, code: row.code, summary: `新增阶段 ${row.code} ${row.name}` } })
      return row
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error('phase_duplicate_code')
    throw error
  }
}

export async function updateProjectPhase(projectId: string, phaseId: string, input: PhaseUpdateInput) {
  await assertProject(projectId)
  const [existing] = await db.select().from(projectPhases).where(and(eq(projectPhases.id, phaseId), eq(projectPhases.projectId, projectId), eq(projectPhases.isCurrent, true))).limit(1)
  if (!existing) return undefined
  validateInput(input, true)
  if (Object.keys(input).length === 0) return existing
  const nextStatus = input.status ?? existing.status
  const nextProgress = input.progress ?? existing.progress
  const nextStart = input.plannedStartDate === undefined ? existing.plannedStartDate : nullable(input.plannedStartDate)
  const nextEnd = input.plannedEndDate === undefined ? existing.plannedEndDate : nullable(input.plannedEndDate)
  validateProgressStatus(nextProgress, nextStatus)
  validateDateRange(nextStart, nextEnd)
  await validateProjectDates(projectId, nextStart, nextEnd)
  const desired = {
    name: input.name === undefined ? existing.name : input.name.trim(),
    code: input.code === undefined ? existing.code : input.code.trim(),
    status: nextStatus,
    progress: nextProgress,
    plannedStartDate: nextStart,
    plannedEndDate: nextEnd,
  }
  const changes: Record<string, unknown> = {}
  for (const key of Object.keys(desired) as Array<keyof typeof desired>) if (desired[key] !== existing[key]) changes[key] = { from: existing[key], to: desired[key] }
  if (!Object.keys(changes).length) return existing
  try {
    return await db.transaction(async tx => {
      const [row] = await tx.update(projectPhases).set({ ...desired, updatedAt: new Date() }).where(and(eq(projectPhases.id, phaseId), eq(projectPhases.projectId, projectId))).returning()
      const action = desired.status !== existing.status ? 'status_changed' : 'updated'
      await tx.insert(auditLogs).values({ projectId, entityType: 'phase', entityId: row.id, action, actorName: 'system', changes: { ...changes, name: row.name, summary: `更新阶段 ${row.code} ${row.name}` } })
      return row
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error('phase_duplicate_code')
    throw error
  }
}

export async function reorderProjectPhases(projectId: string, input: PhaseReorderInput | string[]) {
  await assertProject(projectId)
  const phaseIds = Array.isArray(input) ? input : input.phaseIds
  if (!Array.isArray(phaseIds) || phaseIds.length === 0 || phaseIds.some(id => typeof id !== 'string') || new Set(phaseIds).size !== phaseIds.length) throw new Error('phase_reorder_invalid')
  const rows = await db.select({ id: projectPhases.id }).from(projectPhases).where(and(eq(projectPhases.projectId, projectId), eq(projectPhases.isCurrent, true), inArray(projectPhases.id, phaseIds)))
  if (rows.length !== phaseIds.length) throw new Error('phase_not_found')
  return db.transaction(async tx => {
    for (const [index, phaseId] of phaseIds.entries()) await tx.update(projectPhases).set({ sortOrder: index, updatedAt: new Date() }).where(and(eq(projectPhases.id, phaseId), eq(projectPhases.projectId, projectId)))
    await tx.insert(auditLogs).values({ projectId, entityType: 'phase', action: 'updated', actorName: 'system', changes: { phaseIds, summary: '重新排序项目阶段' } })
    return tx.select().from(projectPhases).where(and(eq(projectPhases.projectId, projectId), eq(projectPhases.isCurrent, true))).orderBy(asc(projectPhases.sortOrder))
  })
}

export async function deleteProjectPhase(projectId: string, phaseId: string) {
  await assertProject(projectId)
  const [existing] = await db.select().from(projectPhases).where(and(eq(projectPhases.id, phaseId), eq(projectPhases.projectId, projectId), eq(projectPhases.isCurrent, true))).limit(1)
  if (!existing) return undefined
  const refs = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.phaseId, phaseId))).limit(1)
  if (refs.length) throw new Error('phase_has_tasks')
  await db.transaction(async tx => {
    await tx.delete(projectPhases).where(and(eq(projectPhases.id, phaseId), eq(projectPhases.projectId, projectId)))
    await tx.insert(auditLogs).values({ projectId, entityType: 'phase', entityId: phaseId, action: 'deleted', actorName: 'system', changes: { name: existing.name, code: existing.code, summary: `删除阶段 ${existing.code} ${existing.name}` } })
  })
  return existing
}

async function assertProject(projectId: string) { const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1); if (!row) throw new Error('project_not_found') }
async function validateProjectDates(projectId: string, start?: string | null, end?: string | null) { const [project] = await db.select({ startDate: projects.startDate, plannedEndDate: projects.plannedEndDate }).from(projects).where(eq(projects.id, projectId)).limit(1); if (!project) throw new Error('project_not_found'); if (start && project.startDate && start < project.startDate) throw new Error('phase_date_outside_project'); if (end && project.plannedEndDate && end > project.plannedEndDate) throw new Error('phase_date_outside_project') }
function validateInput(input: unknown, partial = false): asserts input is PhaseInput { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('phase_body_invalid'); const value = input as Record<string, unknown>; for (const key of Object.keys(value)) if (!fields.has(key)) throw new Error('phase_field_invalid'); if (!partial && (typeof value.name !== 'string' || !value.name.trim() || typeof value.code !== 'string' || !value.code.trim())) throw new Error('phase_name_and_code_required'); if (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim())) throw new Error('phase_name_invalid'); if (value.code !== undefined && (typeof value.code !== 'string' || !value.code.trim())) throw new Error('phase_code_invalid'); if (value.status !== undefined && (typeof value.status !== 'string' || !statuses.has(value.status as PhaseStatus))) throw new Error('phase_status_invalid'); if (value.progress !== undefined && (typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100)) throw new Error('phase_progress_invalid'); for (const key of ['plannedStartDate', 'plannedEndDate'] as const) if (value[key] !== undefined && value[key] !== null && (typeof value[key] !== 'string' || !isDate(value[key]))) throw new Error(`phase_${key}_invalid`); if (typeof value.plannedStartDate === 'string' && typeof value.plannedEndDate === 'string') validateDateRange(value.plannedStartDate, value.plannedEndDate) }
function validateDateRange(start: string | null, end: string | null) { if (start && end && start > end) throw new Error('phase_date_range_invalid') }
function validateProgressStatus(progress: number, status: PhaseStatus) { if (status === 'completed' && progress !== 100) throw new Error('completed_phase_requires_100_progress'); if (progress === 100 && !terminalStatuses.has(status)) throw new Error('100_progress_requires_completed_status') }
function nullable(value: string | null | undefined) { return value === null || value === undefined || value === '' ? null : value }
function isDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value }
function isUniqueViolation(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505') }

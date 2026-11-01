import { and, asc, eq, ne, notLike } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { projects } from '../../db/schema.ts'
import { recordAuditLog } from '../audit/audit-log.ts'

export type ProjectStatus = 'planning' | 'in_progress' | 'on_hold' | 'completed' | 'archived'
export type ProjectInput = {
  code: string
  name: string
  shortName?: string | null
  category?: string | null
  status?: ProjectStatus
  health?: 'healthy' | 'attention' | 'risk'
  description?: string | null
  clientName?: string | null
  startDate?: string | null
  plannedEndDate?: string | null
  actualEndDate?: string | null
  progress?: number
  metadata?: Record<string, unknown>
}

const statuses = new Set<ProjectStatus>(['planning', 'in_progress', 'on_hold', 'completed', 'archived'])
const healthStatuses = new Set(['healthy', 'attention', 'risk'])
const fields = new Set(['code', 'name', 'shortName', 'category', 'status', 'health', 'description', 'clientName', 'startDate', 'plannedEndDate', 'actualEndDate', 'progress', 'metadata'])
const nullableTextFields = new Set(['shortName', 'category', 'description', 'clientName'])
const dateFields = ['startDate', 'plannedEndDate', 'actualEndDate'] as const

export async function listProjects(includeArchived = false) {
  const domain = notLike(projects.code, 'OPP-%')
  return db.select().from(projects).where(includeArchived ? domain : and(domain, ne(projects.status, 'archived'))).orderBy(asc(projects.code))
}

export async function getProject(projectId: string) {
  validateId(projectId)
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  return row
}

export async function createProject(input: ProjectInput) {
  validateInput(input)
  const values = normalizeInput(input)
  const [row] = await db.insert(projects).values(values).returning()
  await recordAuditLog({ projectId: row.id, entityType: 'project', entityId: row.id, action: 'created', changes: { name: row.name, code: row.code, summary: `新增项目 ${row.code} ${row.name}` } })
  return row
}

export async function updateProject(projectId: string, input: Partial<ProjectInput>) {
  const existing = await getProject(projectId)
  if (!existing) return undefined
  validateInput(input, true)
  const next: Partial<ProjectInput> = { ...existing, ...input, health: existing.health as ProjectInput['health'] }
  validateDates(next)
  validateProgress(next.progress)
  const changes: Record<string, unknown> = {}
  for (const key of fields) {
    if (key in input && input[key as keyof ProjectInput] !== existing[key as keyof typeof existing]) changes[key] = { from: existing[key as keyof typeof existing], to: input[key as keyof ProjectInput] }
  }
  if (!Object.keys(changes).length) return existing
  const normalized = normalizeInput(input) as Record<string, unknown>
  const [row] = await db.update(projects).set(normalized as never).where(eq(projects.id, projectId)).returning()
  await recordAuditLog({ projectId, entityType: 'project', entityId: projectId, action: input.status && input.status !== existing.status ? 'status_changed' : 'updated', changes: { ...changes, name: row.name, summary: `更新项目 ${row.code} ${row.name}` } })
  return row
}

export async function archiveProject(projectId: string) { return updateProject(projectId, { status: 'archived' }) }
export async function restoreProject(projectId: string, status: Exclude<ProjectStatus, 'archived'> = 'planning') {
  return updateProject(projectId, { status })
}

function validateId(id: string) { if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('project_id_invalid') }
function validateInput(input: unknown, partial = false): asserts input is Partial<ProjectInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('project_body_invalid')
  for (const key of Object.keys(input)) if (!fields.has(key)) throw new Error('project_field_invalid')
  const value = input as Partial<ProjectInput>
  if (!partial && (typeof value.code !== 'string' || !value.code.trim() || typeof value.name !== 'string' || !value.name.trim())) throw new Error('project_code_and_name_required')
  for (const key of ['code', 'name'] as const) if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim())) throw new Error(`project_${key}_invalid`)
  for (const key of nullableTextFields) { const v = value[key as keyof ProjectInput]; if (v !== undefined && v !== null && typeof v !== 'string') throw new Error(`project_${key}_invalid`) }
  if (value.status !== undefined && (typeof value.status !== 'string' || !statuses.has(value.status))) throw new Error('project_status_invalid')
  if (value.health !== undefined && (typeof value.health !== 'string' || !healthStatuses.has(value.health))) throw new Error('project_health_invalid')
  if (value.progress !== undefined) validateProgress(value.progress)
  for (const key of dateFields) if (value[key] !== undefined && value[key] !== null && (typeof value[key] !== 'string' || !isDate(value[key]))) throw new Error(`project_${key}_invalid`)
  validateDates(value)
  if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== 'object' || Array.isArray(value.metadata))) throw new Error('project_metadata_invalid')
}
function validateDates(value: Partial<ProjectInput>) {
  if (value.startDate && value.plannedEndDate && value.startDate > value.plannedEndDate) throw new Error('project_date_range_invalid')
  if (value.actualEndDate && value.startDate && value.actualEndDate < value.startDate) throw new Error('project_date_range_invalid')
}
function validateProgress(value: unknown) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('project_progress_invalid') }
function isDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return date.toISOString().slice(0, 10) === value }
function normalizeInput(input: Partial<ProjectInput>) {
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(input)) { const value = input[key as keyof ProjectInput]; output[key] = typeof value === 'string' && (key === 'code' || key === 'name' || nullableTextFields.has(key)) ? (value.trim() || null) : value }
  return output as never
}

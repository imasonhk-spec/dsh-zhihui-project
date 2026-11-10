import { and, asc, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, milestones, projects } from '../../db/schema.ts'

export type MilestoneType = 'key' | 'important' | 'normal'
export type MilestoneStatus = 'not_started' | 'in_progress' | 'delayed' | 'completed' | 'cancelled'
export type MilestoneWarning = { level: 'normal' | 'upcoming' | 'overdue'; daysRemaining: number | null; label: string }
const allowedTypes = new Set(['key', 'important', 'normal'])
const allowedStatuses = new Set(['not_started', 'in_progress', 'delayed', 'completed', 'cancelled'])
const allowedInputKeys = new Set(['name', 'description', 'type', 'status', 'ownerName', 'plannedDate', 'actualDate', 'deliverable'])

type MilestoneInput = { name: string; description?: string | null; type?: string; status?: string; ownerName?: string | null; plannedDate: string; actualDate?: string | null; deliverable?: string | null }
export type MilestoneItem = ReturnType<typeof toMilestoneItem>

export function normalizeMilestoneType(value: string): MilestoneType {
  if (value === 'key' || value === '关键') return 'key'
  if (value === 'normal' || value === '一般') return 'normal'
  if (value === 'important' || value === '重要') return 'important'
  return 'important'
}

export function evaluateMilestoneWarning(status: string, plannedDate: string, now = new Date()): MilestoneWarning {
  if (status === 'completed' || status === 'cancelled') return { level: 'normal', daysRemaining: null, label: status === 'completed' ? '已完成' : '已取消' }
  const today = toDateOnly(now)
  const days = daysBetween(today, plannedDate)
  if (days < 0) return { level: 'overdue', daysRemaining: days, label: `已逾期 ${Math.abs(days)} 天` }
  if (days <= 7) return { level: 'upcoming', daysRemaining: days, label: days === 0 ? '今天到期' : `${days} 天后到期` }
  return { level: 'normal', daysRemaining: days, label: '正常' }
}

export async function listProjectMilestones(projectId: string, filters: { q?: string; status?: string; type?: string; ownerName?: string; range?: string }, now = new Date()) {
  await assertProject(projectId)
  validateFilters(filters)
  await markOverdueMilestones(projectId, now)
  const rows = await db.select().from(milestones).where(eq(milestones.projectId, projectId)).orderBy(asc(milestones.plannedDate))
  const query = filters.q?.trim().toLowerCase()
  const owner = filters.ownerName?.trim().toLowerCase()
  return rows.map(row => toMilestoneItem(row, now)).filter(item => {
    if (query && ![item.name, item.ownerName ?? '', item.deliverable ?? ''].some(value => value.toLowerCase().includes(query))) return false
    if (owner && !(item.ownerName ?? '').toLowerCase().includes(owner)) return false
    if (filters.status && item.status !== filters.status) return false
    if (filters.type && item.type !== filters.type) return false
    if (filters.range === '7d' && !(item.warning.level === 'upcoming' && (item.warning.daysRemaining ?? 99) <= 7)) return false
    if (filters.range === '30d' && !((item.warning.daysRemaining ?? -1) >= 0 && (item.warning.daysRemaining ?? 99) <= 30)) return false
    if (filters.range === 'overdue' && item.warning.level !== 'overdue') return false
    return true
  }).sort(compareMilestones)
}

export async function getProjectMilestone(projectId: string, milestoneId: string, now = new Date()) {
  await assertProject(projectId)
  await markOverdueMilestones(projectId, now)
  const [row] = await db.select().from(milestones).where(and(eq(milestones.id, milestoneId), eq(milestones.projectId, projectId))).limit(1)
  return row ? toMilestoneItem(row, now) : undefined
}

export async function createProjectMilestone(projectId: string, input: MilestoneInput, now = new Date()) {
  await assertProject(projectId); validateInput(input)
  await assertUniqueMilestone(projectId, input.name.trim(), input.plannedDate)
  const status = (input.status ?? 'not_started') as MilestoneStatus
  const actualDate = status === 'completed' ? nullable(input.actualDate) ?? toDateOnly(now) : nullable(input.actualDate)
  return db.transaction(async tx => {
    const [row] = await tx.insert(milestones).values({ projectId, name: input.name.trim(), description: nullable(input.description), type: normalizeWriteType(input.type ?? 'important'), status, ownerName: nullable(input.ownerName), plannedDate: input.plannedDate, actualDate, deliverable: nullable(input.deliverable) }).returning()
    await tx.insert(auditLogs).values({ projectId, entityType: 'milestone', entityId: row.id, action: 'created', actorName: 'system', changes: { name: row.name, summary: `新增里程碑 ${row.name}` } })
    return toMilestoneItem(row, now)
  })
}

export async function updateProjectMilestone(projectId: string, milestoneId: string, input: Partial<MilestoneInput>, now = new Date()) {
  await assertProject(projectId)
  const [existing] = await db.select().from(milestones).where(and(eq(milestones.id, milestoneId), eq(milestones.projectId, projectId))).limit(1)
  if (!existing) return undefined
  validateInput(input, true)
  if (Object.keys(input).length === 0) return toMilestoneItem(existing, now)
  const nextName = input.name?.trim() ?? existing.name
  const nextPlannedDate = input.plannedDate ?? existing.plannedDate
  if (nextName !== existing.name || nextPlannedDate !== existing.plannedDate) await assertUniqueMilestone(projectId, nextName, nextPlannedDate, milestoneId)
  const nextStatus = (input.status ?? existing.status) as MilestoneStatus
  let actualDate = input.actualDate === undefined ? existing.actualDate : nullable(input.actualDate)
  if (nextStatus === 'completed' && !actualDate) actualDate = toDateOnly(now)
  if (existing.status === 'completed' && nextStatus !== 'completed' && input.actualDate === undefined) actualDate = null
  const desired = { name: nextName, description: input.description === undefined ? existing.description : nullable(input.description), type: input.type === undefined ? existing.type : normalizeWriteType(input.type), status: nextStatus, ownerName: input.ownerName === undefined ? existing.ownerName : nullable(input.ownerName), plannedDate: nextPlannedDate, actualDate, deliverable: input.deliverable === undefined ? existing.deliverable : nullable(input.deliverable) }
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of Object.keys(desired) as Array<keyof typeof desired>) if (desired[key] !== existing[key]) changes[key] = { from: existing[key], to: desired[key] }
  if (Object.keys(changes).length === 0) return toMilestoneItem(existing, now)
  return db.transaction(async tx => {
    const [row] = await tx.update(milestones).set({ ...desired, updatedAt: new Date() } as never).where(and(eq(milestones.id, milestoneId), eq(milestones.projectId, projectId))).returning()
    const action = desired.status !== existing.status ? 'status_changed' : 'updated'
    await tx.insert(auditLogs).values({ projectId, entityType: 'milestone', entityId: row.id, action, actorName: 'system', changes: { ...changes, name: row.name, summary: action === 'status_changed' ? `里程碑 ${row.name} 状态由 ${existing.status} 变为 ${row.status}` : `更新里程碑 ${row.name}` } })
    return toMilestoneItem(row, now)
  })
}

async function markOverdueMilestones(projectId: string, now: Date) {
  const rows = await db.select().from(milestones).where(eq(milestones.projectId, projectId))
  for (const row of rows) if (!['completed', 'cancelled', 'delayed'].includes(row.status) && evaluateMilestoneWarning(row.status, row.plannedDate, now).level === 'overdue') {
    await db.transaction(async tx => {
      const [updated] = await tx.update(milestones).set({ status: 'delayed', updatedAt: new Date() }).where(and(eq(milestones.id, row.id), eq(milestones.projectId, projectId), eq(milestones.status, row.status))).returning({ id: milestones.id })
      if (updated) await tx.insert(auditLogs).values({ projectId, entityType: 'milestone', entityId: row.id, action: 'status_changed', actorName: 'system', changes: { name: row.name, status: { from: row.status, to: 'delayed' }, summary: `里程碑 ${row.name} 已自动标记延期` } })
    })
  }
}

function toMilestoneItem(row: typeof milestones.$inferSelect, now = new Date()) { return { ...row, type: normalizeMilestoneType(row.type), warning: evaluateMilestoneWarning(row.status, row.plannedDate, now) } }
function compareMilestones(a: MilestoneItem, b: MilestoneItem) { const score = (item: MilestoneItem) => item.warning.level === 'overdue' ? 0 : item.warning.level === 'upcoming' ? 1 : item.status === 'completed' ? 3 : item.status === 'cancelled' ? 4 : 2; return score(a) - score(b) || a.plannedDate.localeCompare(b.plannedDate) }
function validateFilters(filters: { status?: string; type?: string; range?: string }) { if (filters.status && !allowedStatuses.has(filters.status)) throw new Error('milestone_status_invalid'); if (filters.type && !allowedTypes.has(filters.type)) throw new Error('milestone_type_invalid'); if (filters.range && !['7d', '30d', 'overdue'].includes(filters.range)) throw new Error('milestone_range_invalid') }
function validateInput(input: Partial<MilestoneInput>, partial = false) { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('milestone_body_invalid'); for (const key of Object.keys(input)) if (!allowedInputKeys.has(key)) throw new Error('milestone_field_invalid'); if (!partial && (typeof input.name !== 'string' || !input.name.trim() || typeof input.plannedDate !== 'string' || !input.plannedDate)) throw new Error('milestone_name_and_date_required'); if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new Error('milestone_name_invalid'); if (input.type !== undefined && (typeof input.type !== 'string' || !allowedTypes.has(input.type))) throw new Error('milestone_type_invalid'); if (input.status !== undefined && (typeof input.status !== 'string' || !allowedStatuses.has(input.status))) throw new Error('milestone_status_invalid'); for (const key of ['description', 'ownerName', 'plannedDate', 'actualDate', 'deliverable'] as const) if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') throw new Error(`milestone_${key}_invalid`); if (input.plannedDate !== undefined && (typeof input.plannedDate !== 'string' || !input.plannedDate || !isDate(input.plannedDate))) throw new Error('milestone_date_invalid'); if (input.actualDate && !isDate(input.actualDate)) throw new Error('milestone_actual_date_invalid') }
async function assertUniqueMilestone(projectId: string, name: string, plannedDate: string, exceptId?: string) { const rows = await db.select({ id: milestones.id }).from(milestones).where(and(eq(milestones.projectId, projectId), eq(milestones.name, name), eq(milestones.plannedDate, plannedDate))); if (rows.some(row => row.id !== exceptId)) throw new Error('milestone_duplicate') }
async function assertProject(projectId: string) { const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1); if (!row) throw new Error('project_not_found') }
function normalizeWriteType(value: string): MilestoneType { if (!allowedTypes.has(value)) throw new Error('milestone_type_invalid'); return value as MilestoneType }
function nullable(value: string | null | undefined) { return value === null || value === undefined || value === '' ? null : value }
function isDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value }
function toDateOnly(value: Date) { return value.toISOString().slice(0, 10) }
function daysBetween(from: string, to: string) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) }

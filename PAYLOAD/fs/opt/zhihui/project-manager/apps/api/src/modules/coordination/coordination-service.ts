import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, coordinationItems, projects } from '../../db/schema.ts'

export type CoordinationPriority = 'low' | 'medium' | 'high' | 'critical'
export type CoordinationStatus = 'to_start' | 'communicating' | 'resolved' | 'closed'
export type CoordinationWarning = { level: 'normal' | 'overdue'; daysRemaining: number | null; label: string }
export type CoordinationFilters = { q?: string; category?: string; priority?: string; status?: string; ownerName?: string; counterparty?: string; range?: string; includeClosed?: string }
export type CoordinationInput = { code: string; category: string; title: string; description?: string | null; counterparty?: string | null; ownerName?: string | null; priority?: string; status?: string; progress?: number; dueDate?: string | null; resolvedAt?: string | null }
const priorities = new Set(['low', 'medium', 'high', 'critical'])
const statuses = new Set(['to_start', 'communicating', 'resolved', 'closed'])
const inputKeys = new Set(['code', 'category', 'title', 'description', 'counterparty', 'ownerName', 'priority', 'status', 'progress', 'dueDate', 'resolvedAt'])
const terminalStatuses = new Set(['resolved', 'closed'])

export function evaluateCoordinationWarning(status: string, dueDate: string | null, now = new Date()): CoordinationWarning {
  if (!dueDate || terminalStatuses.has(status)) return { level: 'normal', daysRemaining: null, label: status === 'resolved' ? '已解决' : status === 'closed' ? '已关闭' : '正常' }
  const days = daysBetween(toDateOnly(now), dueDate)
  return days < 0 ? { level: 'overdue', daysRemaining: days, label: `已逾期 ${Math.abs(days)} 天` } : { level: 'normal', daysRemaining: days, label: days === 0 ? '今天到期' : `${days} 天后到期` }
}

export async function listProjectCoordinationItems(projectId: string, filters: CoordinationFilters, now = new Date()) {
  await assertProject(projectId); validateFilters(filters)
  const rows = await db.select().from(coordinationItems).where(eq(coordinationItems.projectId, projectId))
  const q = filters.q?.trim().toLowerCase(), category = filters.category?.trim().toLowerCase(), owner = filters.ownerName?.trim().toLowerCase(), counterparty = filters.counterparty?.trim().toLowerCase(), includeClosed = filters.includeClosed === 'true'
  return rows.map(row => toItem(row, now)).filter(item => {
    if (!includeClosed && terminalStatuses.has(item.status)) return false
    if (q && ![item.code, item.category, item.title, item.description ?? '', item.counterparty ?? '', item.ownerName ?? ''].some(value => value.toLowerCase().includes(q))) return false
    if (category && !item.category.toLowerCase().includes(category)) return false
    if (filters.priority && item.priority !== filters.priority && !(filters.priority === 'high' && item.priority === 'critical')) return false
    if (filters.status && item.status !== filters.status) return false
    if (owner && !(item.ownerName ?? '').toLowerCase().includes(owner)) return false
    if (counterparty && !(item.counterparty ?? '').toLowerCase().includes(counterparty)) return false
    if (filters.range === 'overdue' && item.warning.level !== 'overdue') return false
    return true
  }).sort(compareItems)
}

export async function getProjectCoordinationItem(projectId: string, itemId: string, now = new Date()) {
  await assertProject(projectId)
  const [row] = await db.select().from(coordinationItems).where(and(eq(coordinationItems.id, itemId), eq(coordinationItems.projectId, projectId))).limit(1)
  return row ? toItem(row, now) : undefined
}

export async function createProjectCoordinationItem(projectId: string, input: CoordinationInput, now = new Date(), options: { inferResolvedAt?: boolean } = {}) {
  await assertProject(projectId); validateInput(input); await assertUniqueCode(projectId, input.code.trim())
  const status = (input.status ?? 'to_start') as CoordinationStatus
  const terminal = terminalStatuses.has(status)
  const progress = terminal ? 100 : input.progress ?? 0
  if (!terminal && progress === 100) throw new Error('coordination_progress_status_invalid')
  const resolvedAt = terminal ? nullable(input.resolvedAt) ?? (options.inferResolvedAt === false ? null : toDateOnly(now)) : null
  return db.transaction(async tx => {
    const [row] = await tx.insert(coordinationItems).values({ projectId, code: input.code.trim(), category: input.category.trim(), title: input.title.trim(), description: nullable(input.description), counterparty: nullable(input.counterparty), ownerName: nullable(input.ownerName), priority: (input.priority ?? 'medium') as CoordinationPriority, status, progress, dueDate: nullable(input.dueDate), resolvedAt }).returning()
    await tx.insert(auditLogs).values({ projectId, entityType: 'coordination', entityId: row.id, action: 'created', actorName: 'system', changes: { title: row.title, summary: `新增协调事项 ${row.code} ${row.title}` } })
    return toItem(row, now)
  })
}

export async function updateProjectCoordinationItem(projectId: string, itemId: string, input: Partial<CoordinationInput>, now = new Date(), options: { inferResolvedAt?: boolean } = {}) {
  await assertProject(projectId)
  const [existing] = await db.select().from(coordinationItems).where(and(eq(coordinationItems.id, itemId), eq(coordinationItems.projectId, projectId))).limit(1)
  if (!existing) return undefined
  validateInput(input, true); if (!Object.keys(input).length) return toItem(existing, now)
  const code = input.code?.trim() ?? existing.code; if (code !== existing.code) await assertUniqueCode(projectId, code, itemId)
  const status = (input.status ?? existing.status) as CoordinationStatus, terminal = terminalStatuses.has(status), wasTerminal = terminalStatuses.has(existing.status)
  let progress = input.progress ?? existing.progress
  if (terminal) progress = 100
  else if (wasTerminal && input.progress === undefined) progress = 0
  if (!terminal && progress === 100) throw new Error('coordination_progress_status_invalid')
  const resolvedAt = terminal ? (input.resolvedAt === undefined ? existing.resolvedAt : nullable(input.resolvedAt)) ?? (options.inferResolvedAt === false ? null : toDateOnly(now)) : null
  const desired = { code, category: input.category?.trim() ?? existing.category, title: input.title?.trim() ?? existing.title, description: input.description === undefined ? existing.description : nullable(input.description), counterparty: input.counterparty === undefined ? existing.counterparty : nullable(input.counterparty), ownerName: input.ownerName === undefined ? existing.ownerName : nullable(input.ownerName), priority: (input.priority ?? existing.priority) as CoordinationPriority, status, progress, dueDate: input.dueDate === undefined ? existing.dueDate : nullable(input.dueDate), resolvedAt }
  const changes: Record<string, { from: unknown; to: unknown }> = {}; for (const key of Object.keys(desired) as Array<keyof typeof desired>) if (desired[key] !== existing[key]) changes[key] = { from: existing[key], to: desired[key] }
  if (!Object.keys(changes).length) return toItem(existing, now)
  return db.transaction(async tx => {
    const [row] = await tx.update(coordinationItems).set({ ...desired, updatedAt: new Date() }).where(and(eq(coordinationItems.id, itemId), eq(coordinationItems.projectId, projectId))).returning()
    const action = status !== existing.status ? status === 'resolved' ? 'resolved' : status === 'closed' ? 'closed' : 'status_changed' : progress !== existing.progress ? 'progress_changed' : 'updated'
    await tx.insert(auditLogs).values({ projectId, entityType: 'coordination', entityId: row.id, action, actorName: 'system', changes: { ...changes, title: row.title, summary: `协调事项 ${row.code} ${row.title} ${action === 'updated' ? '已更新' : action === 'progress_changed' ? `进度由 ${existing.progress} 变为 ${row.progress}` : `状态由 ${existing.status} 变为 ${row.status}`}` } })
    return toItem(row, now)
  })
}

function toItem(row: typeof coordinationItems.$inferSelect, now: Date) { return { ...row, warning: evaluateCoordinationWarning(row.status, row.dueDate, now) } }
function compareItems(a: ReturnType<typeof toItem>, b: ReturnType<typeof toItem>) { const priority = (item: ReturnType<typeof toItem>) => ({ critical: 4, high: 3, medium: 2, low: 1 })[item.priority]; return priority(b) - priority(a) || Number(b.warning.level === 'overdue') - Number(a.warning.level === 'overdue') || String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999')) || b.updatedAt.getTime() - a.updatedAt.getTime() }
function validateFilters(input: CoordinationFilters) { if (input.priority && !priorities.has(input.priority)) throw new Error('coordination_priority_invalid'); if (input.status && !statuses.has(input.status)) throw new Error('coordination_status_invalid'); if (input.range && input.range !== 'overdue') throw new Error('coordination_range_invalid'); if (input.includeClosed && !['true','false'].includes(input.includeClosed)) throw new Error('coordination_include_closed_invalid') }
function validateInput(input: Partial<CoordinationInput>, partial = false) { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('coordination_body_invalid'); for (const key of Object.keys(input)) if (!inputKeys.has(key)) throw new Error('coordination_field_invalid'); if (!partial && (typeof input.code !== 'string' || !input.code.trim() || typeof input.category !== 'string' || !input.category.trim() || typeof input.title !== 'string' || !input.title.trim())) throw new Error('coordination_required'); for (const key of ['code','category','title'] as const) if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) throw new Error(`coordination_${key}_invalid`); for (const key of ['description','counterparty','ownerName','dueDate','resolvedAt'] as const) if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') throw new Error(`coordination_${key}_invalid`); if (input.priority !== undefined && (typeof input.priority !== 'string' || !priorities.has(input.priority))) throw new Error('coordination_priority_invalid'); if (input.status !== undefined && (typeof input.status !== 'string' || !statuses.has(input.status))) throw new Error('coordination_status_invalid'); if (input.progress !== undefined && (typeof input.progress !== 'number' || !Number.isFinite(input.progress) || input.progress < 0 || input.progress > 100)) throw new Error('coordination_progress_invalid'); for (const key of ['dueDate','resolvedAt'] as const) if (input[key] && !isDate(input[key])) throw new Error(`coordination_${key}_invalid`) }
async function assertUniqueCode(projectId: string, code: string, exceptId?: string) { const rows = await db.select({ id: coordinationItems.id }).from(coordinationItems).where(and(eq(coordinationItems.projectId, projectId), eq(coordinationItems.code, code))); if (rows.some(row => row.id !== exceptId)) throw new Error('coordination_duplicate') }
async function assertProject(projectId: string) { const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1); if (!row) throw new Error('project_not_found') }
function nullable(value: string | null | undefined) { return value === null || value === undefined || value === '' ? null : value }
function isDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10) === value }
function toDateOnly(value: Date) { return value.toISOString().slice(0,10) }
function daysBetween(from: string, to: string) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) }

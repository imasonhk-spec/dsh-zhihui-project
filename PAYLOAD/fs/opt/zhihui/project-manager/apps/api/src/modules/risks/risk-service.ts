import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, projects, risks } from '../../db/schema.ts'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type RiskStatus = 'identified' | 'following' | 'mitigated' | 'closed' | 'accepted'
export type RiskWarning = { level: 'normal' | 'overdue'; daysRemaining: number | null; label: string }
const levels = new Set(['low', 'medium', 'high', 'critical'])
const statuses = new Set(['identified', 'following', 'mitigated', 'closed', 'accepted'])
const inputKeys = new Set(['code', 'name', 'description', 'impact', 'mitigation', 'level', 'status', 'ownerName', 'source', 'expectedResolutionDate', 'closedAt'])
type RiskInput = { code: string; name: string; description?: string | null; impact?: string | null; mitigation?: string | null; level?: string; status?: string; ownerName?: string | null; source?: string | null; expectedResolutionDate?: string | null; closedAt?: string | null }

export function evaluateRiskWarning(status: string, expectedDate: string | null, now = new Date()): RiskWarning {
  if (!expectedDate || status === 'closed' || status === 'accepted') return { level: 'normal', daysRemaining: null, label: status === 'closed' ? '已关闭' : status === 'accepted' ? '已接受' : '正常' }
  const days = daysBetween(toDateOnly(now), expectedDate)
  return days < 0 ? { level: 'overdue', daysRemaining: days, label: `已逾期 ${Math.abs(days)} 天` } : { level: 'normal', daysRemaining: days, label: days === 0 ? '今天到期' : `${days} 天后到期` }
}

export async function listProjectRisks(projectId: string, filters: { q?: string; level?: string; status?: string; ownerName?: string; source?: string; range?: string; includeClosed?: string }, now = new Date()) {
  await assertProject(projectId); validateFilters(filters)
  const rows = await db.select().from(risks).where(eq(risks.projectId, projectId))
  const query = filters.q?.trim().toLowerCase(); const owner = filters.ownerName?.trim().toLowerCase(); const source = filters.source?.trim().toLowerCase(); const includeClosed = filters.includeClosed === 'true'
  return rows.map(row => toRiskItem(row, now)).filter(item => {
    if (!includeClosed && (item.status === 'closed' || item.status === 'accepted')) return false
    if (query && ![item.code, item.name, item.description ?? '', item.impact ?? '', item.mitigation ?? '', item.ownerName ?? '', item.source ?? ''].some(value => value.toLowerCase().includes(query))) return false
    if (filters.level && !matchesRiskLevel(item.level, filters.level)) return false
    if (filters.status && !matchesRiskStatus(item.status, filters.status)) return false
    if (owner && !(item.ownerName ?? '').toLowerCase().includes(owner)) return false
    if (source && !(item.source ?? '').toLowerCase().includes(source)) return false
    if (filters.range === 'overdue' && item.warning.level !== 'overdue') return false
    return true
  }).sort(compareRisks)
}

export async function getProjectRisk(projectId: string, riskId: string, now = new Date()) { await assertProject(projectId); const [row] = await db.select().from(risks).where(and(eq(risks.id, riskId), eq(risks.projectId, projectId))).limit(1); return row ? toRiskItem(row, now) : undefined }

export async function createProjectRisk(projectId: string, input: RiskInput, now = new Date()) {
  await assertProject(projectId); validateInput(input); await assertUniqueCode(projectId, input.code.trim())
  const status = (input.status ?? 'identified') as RiskStatus; const closedAt = status === 'closed' ? nullable(input.closedAt) ?? toDateOnly(now) : null
  return db.transaction(async tx => { const [row] = await tx.insert(risks).values({ projectId, code: input.code.trim(), name: input.name.trim(), description: nullable(input.description), impact: nullable(input.impact), mitigation: nullable(input.mitigation), level: (input.level ?? 'medium') as RiskLevel, status, ownerName: nullable(input.ownerName), source: nullable(input.source), expectedResolutionDate: nullable(input.expectedResolutionDate), closedAt }).returning(); await tx.insert(auditLogs).values({ projectId, entityType: 'risk', entityId: row.id, action: 'created', actorName: 'system', changes: { name: row.name, summary: `新增风险 ${row.code} ${row.name}` } }); return toRiskItem(row, now) })
}

export async function updateProjectRisk(projectId: string, riskId: string, input: Partial<RiskInput>, now = new Date()) {
  await assertProject(projectId); const [existing] = await db.select().from(risks).where(and(eq(risks.id, riskId), eq(risks.projectId, projectId))).limit(1); if (!existing) return undefined
  validateInput(input, true); if (!Object.keys(input).length) return toRiskItem(existing, now)
  const code = input.code?.trim() ?? existing.code; if (code !== existing.code) await assertUniqueCode(projectId, code, riskId)
  const status = (input.status ?? existing.status) as RiskStatus; let closedAt = status === 'closed' ? (input.closedAt === undefined ? existing.closedAt : nullable(input.closedAt)) : null; if (status === 'closed' && !closedAt) closedAt = toDateOnly(now)
  const desired = { code, name: input.name?.trim() ?? existing.name, description: input.description === undefined ? existing.description : nullable(input.description), impact: input.impact === undefined ? existing.impact : nullable(input.impact), mitigation: input.mitigation === undefined ? existing.mitigation : nullable(input.mitigation), level: (input.level ?? existing.level) as RiskLevel, status, ownerName: input.ownerName === undefined ? existing.ownerName : nullable(input.ownerName), source: input.source === undefined ? existing.source : nullable(input.source), expectedResolutionDate: input.expectedResolutionDate === undefined ? existing.expectedResolutionDate : nullable(input.expectedResolutionDate), closedAt }
  const changes: Record<string, { from: unknown; to: unknown }> = {}; for (const key of Object.keys(desired) as Array<keyof typeof desired>) if (desired[key] !== existing[key]) changes[key] = { from: existing[key], to: desired[key] }; if (!Object.keys(changes).length) return toRiskItem(existing, now)
  return db.transaction(async tx => { const [row] = await tx.update(risks).set({ ...desired, updatedAt: new Date() }).where(and(eq(risks.id, riskId), eq(risks.projectId, projectId))).returning(); const action = status !== existing.status ? status === 'closed' ? 'closed' : 'status_changed' : 'updated'; await tx.insert(auditLogs).values({ projectId, entityType: 'risk', entityId: row.id, action, actorName: 'system', changes: { ...changes, name: row.name, summary: `风险 ${row.code} ${row.name} ${action === 'updated' ? '已更新' : `状态由 ${existing.status} 变为 ${row.status}`}` } }); return toRiskItem(row, now) })
}

function toRiskItem(row: typeof risks.$inferSelect, now: Date) { return { ...row, warning: evaluateRiskWarning(row.status, row.expectedResolutionDate, now) } }
function matchesRiskLevel(actual: string, filter: string) { return filter === 'high' ? actual === 'high' || actual === 'critical' : actual === filter }
function matchesRiskStatus(actual: string, filter: string) { return actual === filter }
function compareRisks(a: ReturnType<typeof toRiskItem>, b: ReturnType<typeof toRiskItem>) { const score = (item: ReturnType<typeof toRiskItem>) => ({ critical: 4, high: 3, medium: 2, low: 1 })[item.level] + (item.warning.level === 'overdue' ? 10 : 0); return score(b) - score(a) || String(a.expectedResolutionDate ?? '9999').localeCompare(String(b.expectedResolutionDate ?? '9999')) || b.updatedAt.getTime() - a.updatedAt.getTime() }
function validateFilters(input: { level?: string; status?: string; range?: string; includeClosed?: string }) { if (input.level && !levels.has(input.level)) throw new Error('risk_level_invalid'); if (input.status && !statuses.has(input.status)) throw new Error('risk_status_invalid'); if (input.range && input.range !== 'overdue') throw new Error('risk_range_invalid'); if (input.includeClosed && !['true', 'false'].includes(input.includeClosed)) throw new Error('risk_include_closed_invalid') }
function validateInput(input: Partial<RiskInput>, partial = false) { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('risk_body_invalid'); for (const key of Object.keys(input)) if (!inputKeys.has(key)) throw new Error('risk_field_invalid'); if (!partial && (typeof input.code !== 'string' || !input.code.trim() || typeof input.name !== 'string' || !input.name.trim())) throw new Error('risk_code_and_name_required'); if (input.code !== undefined && (typeof input.code !== 'string' || !input.code.trim())) throw new Error('risk_code_invalid'); if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new Error('risk_name_invalid'); if (input.level !== undefined && (typeof input.level !== 'string' || !levels.has(input.level))) throw new Error('risk_level_invalid'); if (input.status !== undefined && (typeof input.status !== 'string' || !statuses.has(input.status))) throw new Error('risk_status_invalid'); for (const key of ['description','impact','mitigation','ownerName','source','expectedResolutionDate','closedAt'] as const) if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') throw new Error(`risk_${key}_invalid`); for (const key of ['expectedResolutionDate','closedAt'] as const) if (input[key] && !isDate(input[key])) throw new Error(`risk_${key}_invalid`) }
async function assertUniqueCode(projectId: string, code: string, exceptId?: string) { const rows = await db.select({ id: risks.id }).from(risks).where(and(eq(risks.projectId, projectId), eq(risks.code, code))); if (rows.some(row => row.id !== exceptId)) throw new Error('risk_duplicate') }
async function assertProject(projectId: string) { const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1); if (!row) throw new Error('project_not_found') }
function nullable(value: string | null | undefined) { return value === null || value === undefined || value === '' ? null : value }
function isDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value }
function toDateOnly(value: Date) { return value.toISOString().slice(0, 10) }
function daysBetween(from: string, to: string) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) }

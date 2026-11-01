import { and, count, desc, eq, gte, lte } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, notifications } from '../../db/schema.ts'

export type ActivityEntityType = 'project' | 'phase' | 'task' | 'dependency' | 'milestone' | 'risk' | 'coordination' | 'approval' | 'folder' | 'document'
export type ActivityAction = 'created' | 'updated' | 'status_changed' | 'progress_changed' | 'closed' | 'resolved' | 'archived' | 'deleted'
export type ActivityFilter = { entityType?: ActivityEntityType; from?: Date; to?: Date; limit?: number; offset?: number }
export type ProjectActivityPage = { items: ProjectActivity[]; total: number; limit: number; offset: number }
export type ProjectActivitySummary = {
  total: number
  byEntityType: Record<string, number>
  byAction: Record<string, number>
}

export async function recordAuditLog(input: {
  projectId?: string | null
  entityType: ActivityEntityType
  entityId?: string | null
  action: ActivityAction
  actorName?: string
  changes?: Record<string, unknown>
}) {
  const [row] = await db.insert(auditLogs).values({
    projectId: input.projectId ?? null,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    action: input.action,
    actorName: input.actorName ?? 'system',
    changes: input.changes ?? {},
  }).returning()
  return row
}

export type ProjectActivity = {
  id: string
  occurredAt: string
  entityType: ActivityEntityType | string
  entityId: string | null
  action: ActivityAction | string
  title: string
  summary: string | null
  actorName: string
}

export async function listProjectActivities(projectId: string, filter: ActivityFilter = {}): Promise<ProjectActivityPage> {
  const conditions = [eq(auditLogs.projectId, projectId)]
  if (filter.entityType) conditions.push(eq(auditLogs.entityType, filter.entityType))
  if (filter.from) conditions.push(gte(auditLogs.createdAt, filter.from))
  if (filter.to) conditions.push(lte(auditLogs.createdAt, filter.to))
  const where = and(...conditions)
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100)
  const offset = Math.max(filter.offset ?? 0, 0)
  const [[totalRow], rows] = await Promise.all([
    db.select({ value: count() }).from(auditLogs).where(where),
    db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(limit).offset(offset),
  ])
  return { items: rows.map(toActivity), total: Number(totalRow?.value ?? 0), limit, offset }
}

export async function listProjectNotifications(projectId: string, limit = 20) {
  const rows = await db.select().from(notifications).where(eq(notifications.projectId, projectId)).orderBy(desc(notifications.createdAt)).limit(Math.min(Math.max(limit, 1), 100))
  return rows.map(row => ({ id: row.id, title: row.title, summary: row.summary, body: row.body, sourceType: row.sourceType, sourceId: row.sourceId, recipientName: row.recipientName, recipientId: row.recipientId, occurredAt: row.createdAt.toISOString(), readAt: row.readAt?.toISOString() ?? null, read: row.readAt !== null }))
}

export async function markProjectNotificationRead(projectId: string, notificationId: string) {
  const [row] = await db.update(notifications).set({ readAt: new Date(), updatedAt: new Date() }).where(and(eq(notifications.id, notificationId), eq(notifications.projectId, projectId))).returning({ id: notifications.id })
  return Boolean(row)
}
export async function listProjectActivitySummary(projectId: string, filter: { entityType?: ActivityEntityType; from?: Date; to?: Date } = {}): Promise<ProjectActivitySummary> {
  const conditions = [eq(auditLogs.projectId, projectId)]
  if (filter.entityType) conditions.push(eq(auditLogs.entityType, filter.entityType))
  if (filter.from) conditions.push(gte(auditLogs.createdAt, filter.from))
  if (filter.to) conditions.push(lte(auditLogs.createdAt, filter.to))
  const rows = await db.select({ entityType: auditLogs.entityType, action: auditLogs.action }).from(auditLogs).where(and(...conditions))
  const byEntityType: Record<string, number> = {}
  const byAction: Record<string, number> = {}
  for (const row of rows) {
    byEntityType[row.entityType] = (byEntityType[row.entityType] ?? 0) + 1
    byAction[row.action] = (byAction[row.action] ?? 0) + 1
  }
  return { total: rows.length, byEntityType, byAction }
}

function toActivity(row: typeof auditLogs.$inferSelect): ProjectActivity {
  const changes = row.changes as Record<string, unknown>
  const entityLabel: Record<string, string> = { project: '项目', phase: '阶段', task: '任务', dependency: '任务依赖', milestone: '里程碑', risk: '风险', coordination: '协调事项', approval: '报批', folder: '知识库目录', document: '文档' }
  const actionLabel: Record<string, string> = { created: '新增', updated: '更新', status_changed: '状态变更', progress_changed: '进度变更', closed: '关闭', resolved: '解决', archived: '归档', deleted: '删除' }
  return {
    id: row.id,
    occurredAt: row.createdAt.toISOString(),
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    title: `${entityLabel[row.entityType] ?? row.entityType}${actionLabel[row.action] ?? row.action}`,
    summary: typeof changes.summary === 'string' ? changes.summary : typeof changes.name === 'string' ? changes.name : null,
    actorName: row.actorName,
  }
}

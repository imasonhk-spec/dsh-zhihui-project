import { and, eq, gte, lte } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, coordinationItems, milestones, projects, risks, tasks } from '../../db/schema.ts'

export type WeeklyReportRange = { from: Date; to: Date; fromDate: string; toDate: string }

export async function getProjectWeeklyReport(projectId: string, range?: { from?: string; to?: string }) {
  const [project] = await db.select({ id: projects.id, code: projects.code, name: projects.name, status: projects.status, progress: projects.progress }).from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) return undefined
  const reportRange = resolveRange(range)
  const nextFrom = addDays(reportRange.toDate, 1)
  const nextTo = addDays(nextFrom, 7)
  const [taskRows, riskRows, milestoneRows, coordinationRows, auditRows] = await Promise.all([
    db.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.isCurrent, true))),
    db.select().from(risks).where(eq(risks.projectId, projectId)),
    db.select().from(milestones).where(eq(milestones.projectId, projectId)),
    db.select().from(coordinationItems).where(eq(coordinationItems.projectId, projectId)),
    db.select().from(auditLogs).where(and(eq(auditLogs.projectId, projectId), gte(auditLogs.createdAt, reportRange.from), lte(auditLogs.createdAt, reportRange.to))).orderBy(auditLogs.createdAt),
  ])
  const inRange = (createdAt: Date, updatedAt: Date) => betweenDate(createdAt, reportRange.fromDate, reportRange.toDate) || betweenDate(updatedAt, reportRange.fromDate, reportRange.toDate)
  const completed = taskRows.filter(task => task.status === 'completed' && (task.actualEndDate ? betweenDate(task.actualEndDate, reportRange.fromDate, reportRange.toDate) : inRange(task.createdAt, task.updatedAt)))
  const inProgress = taskRows.filter(task => ['in_progress', 'ready', 'delayed', 'blocked'].includes(task.status))
  const activeRisks = riskRows.filter(risk => !['accepted', 'closed'].includes(risk.status)).filter(risk => inRange(risk.createdAt, risk.updatedAt))
  const activeCoordination = coordinationRows.filter(item => !['resolved', 'closed'].includes(item.status)).filter(item => inRange(item.createdAt, item.updatedAt))
  const milestoneUpdates = milestoneRows.filter(item => inRange(item.createdAt, item.updatedAt) || betweenDate(item.plannedDate, reportRange.fromDate, reportRange.toDate))
  const nextWeekTasks = taskRows.filter(task => task.status !== 'completed' && task.status !== 'closed' && task.plannedEndDate && betweenDate(task.plannedEndDate, nextFrom, nextTo))
  const nextWeekMilestones = milestoneRows.filter(item => item.status !== 'completed' && item.status !== 'cancelled' && betweenDate(item.plannedDate, nextFrom, nextTo))
  return {
    project,
    range: { from: reportRange.fromDate, to: reportRange.toDate },
    nextWeek: { from: nextFrom, to: nextTo },
    summary: { completedCount: completed.length, inProgressCount: inProgress.length, activeRiskCount: activeRisks.length, activeCoordinationCount: activeCoordination.length, milestoneCount: milestoneUpdates.length, auditChangeCount: auditRows.length, nextWeekPlanCount: nextWeekTasks.length + nextWeekMilestones.length },
    completed: completed.map(taskSummary),
    inProgress: inProgress.map(taskSummary),
    risks: activeRisks.map(risk => ({ id: risk.id, code: risk.code, name: risk.name, level: risk.level, status: risk.status, ownerName: risk.ownerName, expectedResolutionDate: risk.expectedResolutionDate, mitigation: risk.mitigation })),
    coordination: activeCoordination.map(item => ({ id: item.id, code: item.code, title: item.title, category: item.category, priority: item.priority, status: item.status, ownerName: item.ownerName, counterparty: item.counterparty, dueDate: item.dueDate, progress: item.progress })),
    milestones: milestoneUpdates.map(item => ({ id: item.id, name: item.name, status: item.status, plannedDate: item.plannedDate, actualDate: item.actualDate, ownerName: item.ownerName, deliverable: item.deliverable })),
    nextWeekPlan: { tasks: nextWeekTasks.map(taskSummary), milestones: nextWeekMilestones.map(item => ({ id: item.id, name: item.name, status: item.status, plannedDate: item.plannedDate, ownerName: item.ownerName, deliverable: item.deliverable })) },
    auditLogs: auditRows.map(row => ({ id: row.id, occurredAt: row.createdAt.toISOString(), entityType: row.entityType, entityId: row.entityId, action: row.action, actorName: row.actorName, summary: typeof row.changes.summary === 'string' ? row.changes.summary : null })),
  }
}

function taskSummary(task: typeof tasks.$inferSelect) { return { id: task.id, wbsCode: task.wbsCode, name: task.name, status: task.status, progress: task.progress, ownerName: task.ownerName, plannedEndDate: task.plannedEndDate, actualEndDate: task.actualEndDate, deliverable: task.deliverable } }
function resolveRange(input?: { from?: string; to?: string }): WeeklyReportRange {
  const today = new Date().toISOString().slice(0, 10)
  const toDate = input?.to ?? today
  const fromDate = input?.from ?? addDays(toDate, -6)
  if (!isDate(fromDate) || !isDate(toDate) || fromDate > toDate) throw new Error('weekly_report_date_range_invalid')
  return { from: new Date(`${fromDate}T00:00:00.000Z`), to: new Date(`${toDate}T23:59:59.999Z`), fromDate, toDate }
}
function isDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) }
function addDays(value: string, amount: number) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10) }
function betweenDate(value: string | Date, from: string, to: string) { const date = typeof value === 'string' ? value : value.toISOString().slice(0, 10); return date >= from && date <= to }

import { and, asc, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { approvalItems, coordinationItems, documents, knowledgeBases, knowledgeFolders, milestones, projectPhases, projects, risks, tasks } from '../../db/schema.ts'
import { evaluateProjectHealth, type HealthReason, type ProjectHealth } from './project-overview.ts'

export type ProjectOverviewDetail = {
  project: {
    id: string
    code: string
    name: string
    category: string | null
    clientName: string | null
    description: string | null
    status: 'planning' | 'in_progress' | 'on_hold' | 'completed' | 'archived'
    manualHealth: string
    computedHealth: ProjectHealth
    effectiveHealth: ProjectHealth
    healthReasons: HealthReason[]
    progress: number
    startDate: string | null
    plannedEndDate: string | null
    actualEndDate: string | null
  }
  phases: Array<{ id: string; code: string; name: string; status: string; progress: number; plannedStartDate: string | null; plannedEndDate: string | null }>
  risks: Array<{ id: string; code: string; name: string; level: string; status: string; ownerName: string | null; source: string | null; expectedResolutionDate: string | null }>
  milestones: Array<{ id: string; name: string; type: string; status: string; ownerName: string | null; plannedDate: string; actualDate: string | null; deliverable: string | null }>
  coordinationItems: Array<{ id: string; code: string; title: string; category: string; priority: string; status: string; ownerName: string | null; dueDate: string | null; progress: number }>
  approvalSummary: { total: number; completed: number; overdue: number; progress: number; currentStage: { stageCode: string; stageName: string } | null; nextDeadline: { id: string; taskName: string; plannedEndDate: string } | null; expectedContractDate: string | null }
  knowledgeSummary: { folders: number; documents: number; activeDocuments: number; archivedDocuments: number; storageBytes: number; recentDocuments: Array<{ id: string; name: string; fileType: string; version: string; status: string; folderId: string | null; folderPath: string | null; fileSize: number | null; updatedAt: string }> }
  counts: { activeTasks: number; delayedTasks: number; activeRisks: number; pendingCoordinationItems: number; upcomingMilestones: number; overdueApprovals: number; knowledgeDocuments: number }
}

export async function getProjectOverview(projectId: string, now = new Date()): Promise<ProjectOverviewDetail | undefined> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) return undefined
  const [phaseRows, taskRows, milestoneRows, riskRows, coordinationRows, approvalRows, knowledgeBaseRows] = await Promise.all([
    db.select().from(projectPhases).where(and(eq(projectPhases.projectId, projectId), eq(projectPhases.isCurrent, true))).orderBy(asc(projectPhases.sortOrder)),
    db.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.isCurrent, true))),
    db.select().from(milestones).where(eq(milestones.projectId, projectId)).orderBy(asc(milestones.plannedDate)),
    db.select().from(risks).where(eq(risks.projectId, projectId)),
    db.select().from(coordinationItems).where(eq(coordinationItems.projectId, projectId)),
    db.select().from(approvalItems).where(eq(approvalItems.projectId, projectId)),
    db.select().from(knowledgeBases).where(eq(knowledgeBases.projectId, projectId)).limit(1),
  ])
  const knowledgeBase = knowledgeBaseRows[0]
  const [folderRows, documentRows] = knowledgeBase ? await Promise.all([
    db.select().from(knowledgeFolders).where(eq(knowledgeFolders.knowledgeBaseId, knowledgeBase.id)),
    db.select().from(documents).where(eq(documents.knowledgeBaseId, knowledgeBase.id)),
  ]) : [[], []]
  const folderPaths = new Map(folderRows.map(folder => [folder.id, folder.path]))
  const recentDocuments = [...documentRows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 5)
  const today = now.toISOString().slice(0, 10)
  const upcomingEnd = addDays(today, 7)
  const activeRisks = riskRows.filter(item => item.status !== 'closed' && item.status !== 'accepted')
  const pendingItems = coordinationRows.filter(item => item.status !== 'resolved' && item.status !== 'closed')
  const overdueApprovals = approvalRows.filter(item => !['completed', 'closed', 'cancelled'].includes(item.status) && item.plannedEndDate && item.plannedEndDate < today)
  const approvalStages = [...new Map(approvalRows.map(item => [item.stageCode, item.stageName])).entries()]
  const approvalCompleted = approvalRows.filter(item => item.status === 'completed' || item.status === 'closed').length
  const currentApprovalStage = approvalStages.find(([code]) => approvalRows.some(item => item.stageCode === code && !['completed', 'closed', 'cancelled'].includes(item.status)))
  const nextApprovalDeadline = approvalRows.filter(item => !['completed', 'closed', 'cancelled'].includes(item.status) && item.plannedEndDate).sort((a, b) => a.plannedEndDate!.localeCompare(b.plannedEndDate!))[0]
  const delayedTasks = taskRows.filter(item => item.status === 'delayed' || (item.plannedEndDate !== null && item.plannedEndDate < today && !['completed', 'closed', 'cancelled'].includes(item.status)))
  const delayedMilestones = milestoneRows.filter(item => item.status !== 'completed' && item.status !== 'cancelled' && (item.status === 'delayed' || item.plannedDate < today))
  const delayedCriticalMilestones = delayedMilestones.filter(item => item.type === '关键' || item.type === 'key')
  const delayedOtherMilestones = delayedMilestones.filter(item => item.type !== '关键' && item.type !== 'key')
  const computed = evaluateProjectHealth({
    criticalRiskOpen: activeRisks.filter(item => item.status !== 'mitigated' && item.level === 'critical').length,
    highRiskOverdue: activeRisks.filter(item => item.status !== 'mitigated' && item.level === 'high' && item.expectedResolutionDate && item.expectedResolutionDate < today).length,
    criticalTaskDelayed: delayedTasks.filter(item => item.priority === 'critical').length,
    criticalMilestoneDelayed: delayedCriticalMilestones.length,
    milestoneDelayed: delayedOtherMilestones.length,
    highCoordinationOverdue: pendingItems.filter(item => (item.priority === 'high' || item.priority === 'critical') && item.dueDate && item.dueDate < today).length,
    highRiskOpen: activeRisks.filter(item => item.status !== 'mitigated' && item.level === 'high').length,
    riskOverdue: activeRisks.filter(item => item.expectedResolutionDate && item.expectedResolutionDate < today && (item.status === 'mitigated' || (item.level !== 'high' && item.level !== 'critical'))).length,
    taskDelayed: delayedTasks.filter(item => item.priority !== 'critical').length,
    milestoneUpcoming: milestoneRows.filter(item => item.status !== 'completed' && item.status !== 'cancelled' && item.plannedDate >= today && item.plannedDate <= upcomingEnd).length,
    highCoordinationOpen: pendingItems.filter(item => item.priority === 'high' || item.priority === 'critical').length,
    approvalOverdue: overdueApprovals.length,
  })

  return {
    project: {
      id: project.id, code: project.code, name: project.name, category: project.category, clientName: project.clientName, description: project.description,
      status: project.status, manualHealth: project.health, computedHealth: computed.health, effectiveHealth: computed.health, healthReasons: computed.reasons,
      progress: project.progress, startDate: project.startDate, plannedEndDate: project.plannedEndDate, actualEndDate: project.actualEndDate,
    },
    phases: phaseRows.map(item => ({ id: item.id, code: item.code, name: item.name, status: item.status, progress: item.progress, plannedStartDate: item.plannedStartDate, plannedEndDate: item.plannedEndDate })),
    risks: activeRisks.sort((a, b) => riskScore(b) - riskScore(a) || String(a.expectedResolutionDate ?? '').localeCompare(String(b.expectedResolutionDate ?? ''))).slice(0, 5).map(item => ({ id: item.id, code: item.code, name: item.name, level: item.level, status: item.status, ownerName: item.ownerName, source: item.source, expectedResolutionDate: item.expectedResolutionDate })),
    milestones: [...milestoneRows].sort((a, b) => milestoneScore(b) - milestoneScore(a) || a.plannedDate.localeCompare(b.plannedDate)).slice(0, 5).map(item => ({ id: item.id, name: item.name, type: item.type, status: item.status, ownerName: item.ownerName, plannedDate: item.plannedDate, actualDate: item.actualDate, deliverable: item.deliverable })),
    approvalSummary: { total: approvalRows.length, completed: approvalCompleted, overdue: overdueApprovals.length, progress: approvalRows.length ? Math.round(approvalCompleted / approvalRows.length * 100) : 0, currentStage: currentApprovalStage ? { stageCode: currentApprovalStage[0], stageName: currentApprovalStage[1] } : null, nextDeadline: nextApprovalDeadline ? { id: nextApprovalDeadline.id, taskName: nextApprovalDeadline.taskName, plannedEndDate: nextApprovalDeadline.plannedEndDate! } : null, expectedContractDate: approvalRows.filter(item => item.stageCode === 's4' && item.plannedEndDate).map(item => item.plannedEndDate!).sort().at(-1) ?? null },
    knowledgeSummary: { folders: folderRows.length, documents: documentRows.length, activeDocuments: documentRows.filter(item => !['archived','obsolete'].includes(item.status)).length, archivedDocuments: documentRows.filter(item => item.status === 'archived').length, storageBytes: documentRows.reduce((sum, item) => sum + (item.fileSize ?? 0), 0), recentDocuments: recentDocuments.map(item => ({ id: item.id, name: item.name, fileType: item.fileType, version: item.version, status: item.status, folderId: item.folderId, folderPath: item.folderId ? folderPaths.get(item.folderId) ?? null : null, fileSize: item.fileSize, updatedAt: item.updatedAt.toISOString() })) },
    coordinationItems: pendingItems.sort((a, b) => priorityScore(b.priority) - priorityScore(a.priority) || String(a.dueDate ?? '').localeCompare(String(b.dueDate ?? ''))).slice(0, 5).map(item => ({ id: item.id, code: item.code, title: item.title, category: item.category, priority: item.priority, status: item.status, ownerName: item.ownerName, dueDate: item.dueDate, progress: item.progress })),
    counts: {
      activeTasks: taskRows.filter(item => item.status !== 'completed' && item.status !== 'closed' && item.status !== 'cancelled').length,
      delayedTasks: delayedTasks.length,
      activeRisks: activeRisks.length,
      pendingCoordinationItems: pendingItems.length,
      upcomingMilestones: milestoneRows.filter(item => item.status !== 'completed' && item.status !== 'cancelled' && item.plannedDate >= today && item.plannedDate <= upcomingEnd).length,
      overdueApprovals: overdueApprovals.length,
      knowledgeDocuments: documentRows.length,
    },
  }
}

function priorityScore(priority: string) { return priority === 'critical' ? 4 : priority === 'high' ? 3 : priority === 'medium' ? 2 : 1 }
function riskScore(item: { level: string; status: string }) { return priorityScore(item.level) + (item.status === 'following' ? 1 : 0) }
function milestoneScore(item: { status: string }) { return item.status === 'delayed' ? 3 : item.status === 'in_progress' ? 2 : item.status === 'not_started' ? 1 : 0 }
function addDays(date: string, days: number) { const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }

import { and, asc, eq, ne, notLike } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { approvalItems, coordinationItems, milestones, projects, risks, tasks } from '../../db/schema.ts'

export type ProjectHealth = 'healthy' | 'attention' | 'risk'
export type HealthReasonCode =
  | 'critical_risk_open'
  | 'high_risk_overdue'
  | 'critical_task_delayed'
  | 'critical_milestone_delayed'
  | 'milestone_delayed'
  | 'high_coordination_overdue'
  | 'high_risk_open'
  | 'risk_overdue'
  | 'task_delayed'
  | 'milestone_upcoming'
  | 'high_coordination_open'
  | 'approval_overdue'

export type HealthReason = {
  code: HealthReasonCode
  level: 'attention' | 'risk'
  label: string
  count: number
}

export type PortfolioProject = {
  id: string
  code: string
  name: string
  category: string | null
  clientName: string | null
  status: 'planning' | 'in_progress' | 'on_hold' | 'completed' | 'archived'
  progress: number
  health: ProjectHealth
  manualHealth: string
  computedHealth: ProjectHealth
  effectiveHealth: ProjectHealth
  healthReasons: HealthReason[]
  activeRiskCount: number
  pendingCoordinationCount: number
  upcomingMilestoneCount: number
  plannedEndDate: string | null
  progressPrevious: number | null
}

export type PortfolioSummary = {
  generatedAt: string
  upcomingMilestoneDays: 7
  counts: {
    managedProjects: number
    inProgressProjects: number
    planningProjects: number
    healthyProjects: number
    attentionProjects: number
    riskProjects: number
    keyRisks: number
    pendingCoordinationItems: number
    upcomingMilestones: number
  }
  projects: PortfolioProject[]
}

type ProjectSignals = {
  criticalRiskOpen: number
  highRiskOverdue: number
  criticalTaskDelayed: number
  criticalMilestoneDelayed: number
  milestoneDelayed: number
  highCoordinationOverdue: number
  highRiskOpen: number
  riskOverdue: number
  taskDelayed: number
  milestoneUpcoming: number
  highCoordinationOpen: number
  approvalOverdue: number
}

function wbsProgress(rows: Array<{ status: string }>): number {
  if (!rows.length) return 0
  const completed = rows.filter(row => row.status === 'completed' || row.status === 'closed').length
  return Math.round(completed / rows.length * 100)
}

const emptySignals = (): ProjectSignals => ({
  criticalRiskOpen: 0,
  highRiskOverdue: 0,
  criticalTaskDelayed: 0,
  criticalMilestoneDelayed: 0,
  milestoneDelayed: 0,
  highCoordinationOverdue: 0,
  highRiskOpen: 0,
  riskOverdue: 0,
  taskDelayed: 0,
  milestoneUpcoming: 0,
  highCoordinationOpen: 0,
  approvalOverdue: 0,
})

export function evaluateProjectHealth(signals: ProjectSignals): { health: ProjectHealth; reasons: HealthReason[] } {
  const reasons: HealthReason[] = []
  addReason(reasons, signals.criticalRiskOpen, 'critical_risk_open', 'risk', '存在未关闭的严重风险')
  addReason(reasons, signals.highRiskOverdue, 'high_risk_overdue', 'risk', '高风险预计解决日期已逾期')
  addReason(reasons, signals.criticalTaskDelayed, 'critical_task_delayed', 'risk', '关键任务已延期')
  addReason(reasons, signals.criticalMilestoneDelayed, 'critical_milestone_delayed', 'risk', '关键里程碑已延期')
  addReason(reasons, signals.milestoneDelayed, 'milestone_delayed', 'attention', '存在延期里程碑')
  addReason(reasons, signals.highCoordinationOverdue, 'high_coordination_overdue', 'risk', '高优先级协调事项已逾期')
  addReason(reasons, signals.highRiskOpen, 'high_risk_open', 'attention', '存在未关闭的高风险')
  addReason(reasons, signals.riskOverdue, 'risk_overdue', 'attention', '存在逾期风险')
  addReason(reasons, signals.taskDelayed, 'task_delayed', 'attention', '存在延期任务')
  addReason(reasons, signals.milestoneUpcoming, 'milestone_upcoming', 'attention', '存在未来 7 天内未完成里程碑')
  addReason(reasons, signals.highCoordinationOpen, 'high_coordination_open', 'attention', '存在未解决的高优先级协调事项')
  addReason(reasons, signals.approvalOverdue, 'approval_overdue', 'attention', '存在逾期报批任务')

  if (reasons.some(reason => reason.level === 'risk')) return { health: 'risk', reasons }
  if (reasons.length > 0) return { health: 'attention', reasons }
  return { health: 'healthy', reasons }
}

export async function getPortfolioSummary(now = new Date(), includeArchived = false): Promise<PortfolioSummary> {
  const projectDomain = notLike(projects.code, 'OPP-%')
  const projectQuery = includeArchived ? db.select().from(projects).where(projectDomain).orderBy(asc(projects.code)) : db.select().from(projects).where(and(projectDomain, ne(projects.status, 'archived'))).orderBy(asc(projects.code))
  const [projectRows, taskRows, milestoneRows, riskRows, coordinationRows, approvalRows] = await Promise.all([
    projectQuery,
    db.select().from(tasks).where(eq(tasks.isCurrent, true)),
    db.select().from(milestones),
    db.select().from(risks),
    db.select().from(coordinationItems),
    db.select().from(approvalItems),
  ])
  const today = toDateOnly(now)
  const upcomingEnd = addDays(today, 7)
  const signalsByProject = new Map<string, ProjectSignals>()
  const getSignals = (projectId: string) => {
    const current = signalsByProject.get(projectId) ?? emptySignals()
    signalsByProject.set(projectId, current)
    return current
  }

  for (const task of taskRows) {
    const isDelayed = task.status === 'delayed' || (task.plannedEndDate !== null && task.plannedEndDate < today && !['completed', 'closed', 'cancelled'].includes(task.status))
    if (!isDelayed) continue
    const signals = getSignals(task.projectId)
    if (task.priority === 'critical') signals.criticalTaskDelayed += 1
    else signals.taskDelayed += 1
  }
  for (const milestone of milestoneRows) {
    if (milestone.status === 'completed' || milestone.status === 'cancelled') continue
    const signals = getSignals(milestone.projectId)
    const isDelayed = milestone.status === 'delayed' || milestone.plannedDate < today
    if (isDelayed) {
      if (milestone.type === '关键' || milestone.type === 'key') signals.criticalMilestoneDelayed += 1
      else signals.milestoneDelayed += 1
    }
    if (milestone.plannedDate >= today && milestone.plannedDate <= upcomingEnd) signals.milestoneUpcoming += 1
  }
  for (const risk of riskRows) {
    if (risk.status === 'closed' || risk.status === 'accepted') continue
    const signals = getSignals(risk.projectId)
    const overdue = Boolean(risk.expectedResolutionDate && risk.expectedResolutionDate < today)
    if (risk.status === 'mitigated') { if (overdue) signals.riskOverdue += 1; continue }
    if (risk.level === 'critical') signals.criticalRiskOpen += 1
    if (risk.level === 'high') { signals.highRiskOpen += 1; if (overdue) signals.highRiskOverdue += 1 }
    else if (overdue) signals.riskOverdue += 1
  }
  for (const item of coordinationRows) {
    if (item.status === 'resolved' || item.status === 'closed' || (item.priority !== 'high' && item.priority !== 'critical')) continue
    const signals = getSignals(item.projectId)
    signals.highCoordinationOpen += 1
    if (item.dueDate && item.dueDate < today) signals.highCoordinationOverdue += 1
  }
  for (const item of approvalRows) {
    if (['completed', 'closed', 'cancelled'].includes(item.status) || !item.plannedEndDate || item.plannedEndDate >= today) continue
    getSignals(item.projectId).approvalOverdue += 1
  }

  const portfolioProjects = projectRows.map(project => {
    const signals = signalsByProject.get(project.id) ?? emptySignals()
    const evaluated = evaluateProjectHealth(signals)
    return {
      id: project.id,
      code: project.code,
      name: project.name,
      category: project.category,
      clientName: project.clientName,
      status: project.status,
      progress: project.progress || wbsProgress(taskRows.filter(task => task.projectId === project.id)),
       progressPrevious: getPreviousProgress(project.metadata, project.progress),
      health: evaluated.health,
      manualHealth: project.health,
      computedHealth: evaluated.health,
      effectiveHealth: evaluated.health,
      healthReasons: evaluated.reasons,
      activeRiskCount: riskRows.filter(risk => risk.projectId === project.id && risk.status !== 'closed' && risk.status !== 'accepted').length,
      pendingCoordinationCount: coordinationRows.filter(item => item.projectId === project.id && item.status !== 'resolved' && item.status !== 'closed').length,
      upcomingMilestoneCount: milestoneRows.filter(item => item.projectId === project.id && item.status !== 'completed' && item.status !== 'cancelled' && item.plannedDate >= today && item.plannedDate <= upcomingEnd).length,
      plannedEndDate: project.plannedEndDate,
    } satisfies PortfolioProject
  })

  return {
    generatedAt: now.toISOString(),
    upcomingMilestoneDays: 7,
    counts: {
      managedProjects: portfolioProjects.length,
      inProgressProjects: portfolioProjects.filter(project => project.status === 'in_progress').length,
      planningProjects: portfolioProjects.filter(project => project.status === 'planning').length,
      healthyProjects: portfolioProjects.filter(project => project.effectiveHealth === 'healthy').length,
      attentionProjects: portfolioProjects.filter(project => project.effectiveHealth === 'attention').length,
      riskProjects: portfolioProjects.filter(project => project.effectiveHealth === 'risk').length,
      keyRisks: riskRows.filter(risk => (risk.level === 'high' || risk.level === 'critical') && risk.status !== 'closed' && risk.status !== 'accepted').length,
      pendingCoordinationItems: coordinationRows.filter(item => item.status !== 'resolved' && item.status !== 'closed').length,
      upcomingMilestones: milestoneRows.filter(item => item.status !== 'completed' && item.status !== 'cancelled' && item.plannedDate >= today && item.plannedDate <= upcomingEnd).length,
    },
    projects: portfolioProjects,
  }
}

function getPreviousProgress(metadata: Record<string, unknown>, current: number) { const history = metadata.progressHistory; if (!Array.isArray(history)) return null; const values = history.filter(item => item && typeof item === 'object' && 'weekKey' in item).map(item => item && typeof item === 'object' && 'value' in item ? Number(item.value) : NaN).filter(value => Number.isFinite(value)); return values.length ? values.at(-1)! : null }

function addReason(reasons: HealthReason[], count: number, code: HealthReasonCode, level: HealthReason['level'], label: string) {
  if (count > 0) reasons.push({ code, level, label, count })
}

function toDateOnly(date: Date) {
  return date.toISOString().slice(0, 10)
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

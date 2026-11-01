import { and, desc, eq, gte } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { approvalItems, coordinationItems, milestones, projects, risks, tasks } from '../../db/schema.ts'
import type { DeepSeekHarnessClient } from '../../ai/deepseek-harness.ts'

export type WeeklyProgressSummary = { summary: string; source: 'model' | 'rules'; generatedAt: string; facts: string[] }

export async function getWeeklyProgressSummary(projectId: string, harness?: DeepSeekHarnessClient): Promise<WeeklyProgressSummary | undefined> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) return undefined
  const since = new Date(Date.now() - 7 * 86400000)
  const [taskRows, riskRows, milestoneRows, coordinationRows, approvalRows] = await Promise.all([
    db.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.isCurrent, true), gte(tasks.updatedAt, since))).orderBy(desc(tasks.updatedAt)),
    db.select().from(risks).where(and(eq(risks.projectId, projectId), gte(risks.updatedAt, since))).orderBy(desc(risks.updatedAt)),
    db.select().from(milestones).where(and(eq(milestones.projectId, projectId), gte(milestones.updatedAt, since))).orderBy(desc(milestones.updatedAt)),
    db.select().from(coordinationItems).where(and(eq(coordinationItems.projectId, projectId), gte(coordinationItems.updatedAt, since))).orderBy(desc(coordinationItems.updatedAt)),
    db.select().from(approvalItems).where(and(eq(approvalItems.projectId, projectId), gte(approvalItems.updatedAt, since))).orderBy(desc(approvalItems.updatedAt)),
  ])
  const facts = buildFacts(taskRows, riskRows, milestoneRows, coordinationRows, approvalRows)
  const fallback = buildFallback(project.name, facts)
  if (!harness || !facts.length) return { summary: fallback, source: 'rules', generatedAt: new Date().toISOString(), facts }
  try {
    const session = await harness.createSession()
    const prompt = `你是项目管理周报分析助手。只依据以下结构化事实，总结项目“${project.name}”最近一周的总体进展。\n要求：1）输出1至3句中文，每句不超过55字；2）优先写取得的成果、进入的新阶段、关键阻塞与下一步依赖；3）使用事实型表述，风格类似“指挥大屏与融合通信模块通过初步验收，进入试运行准备阶段”；4）不得补充事实中没有的数字、单位、结论；5）不要标题、序号、Markdown。\n事实：\n${facts.map(item => `- ${item}`).join('\n')}`
    const result = await harness.promptAndWait(session.sessionId, prompt)
    const summary = result.text.replace(/^[-*#\s]+/, '').trim().slice(0, 500)
    if (summary) return { summary, source: 'model', generatedAt: new Date().toISOString(), facts }
  } catch { /* 模型不可用时返回可解释的规则摘要 */ }
  return { summary: fallback, source: 'rules', generatedAt: new Date().toISOString(), facts }
}

function buildFacts(taskRows: any[], riskRows: any[], milestoneRows: any[], coordinationRows: any[], approvalRows: any[]) {
  const facts: string[] = []
  const completedTasks = taskRows.filter(item => item.status === 'completed').slice(0, 3)
  const delayedTasks = taskRows.filter(item => item.status === 'delayed' || item.status === 'blocked').slice(0, 3)
  if (completedTasks.length) facts.push(`完成计划：${completedTasks.map(item => `${item.wbsCode} ${item.name}`).join('；')}`)
  if (delayedTasks.length) facts.push(`延期或阻塞计划：${delayedTasks.map(item => `${item.wbsCode} ${item.name}（${item.progress}%）`).join('；')}`)
  const activeRisks = riskRows.filter(item => !['closed', 'accepted'].includes(item.status)).slice(0, 3)
  if (activeRisks.length) facts.push(`仍在跟进风险：${activeRisks.map(item => `${item.name}（${item.level}）`).join('；')}`)
  const completedMilestones = milestoneRows.filter(item => item.status === 'completed').slice(0, 2)
  const pendingMilestones = milestoneRows.filter(item => !['completed', 'cancelled'].includes(item.status)).slice(0, 2)
  if (completedMilestones.length) facts.push(`达成里程碑：${completedMilestones.map(item => item.name).join('；')}`)
  if (pendingMilestones.length) facts.push(`待推进里程碑：${pendingMilestones.map(item => `${item.name}（计划${item.plannedDate}）`).join('；')}`)
  const pendingCoordination = coordinationRows.filter(item => !['resolved', 'closed'].includes(item.status)).slice(0, 3)
  if (pendingCoordination.length) facts.push(`待协调：${pendingCoordination.map(item => item.title).join('；')}`)
  const completedApprovals = approvalRows.filter(item => ['completed', 'closed'].includes(item.status)).slice(0, 2)
  const pendingApprovals = approvalRows.filter(item => !['completed', 'closed', 'cancelled'].includes(item.status)).slice(0, 2)
  if (completedApprovals.length) facts.push(`报批完成：${completedApprovals.map(item => item.taskName).join('；')}`)
  if (pendingApprovals.length) facts.push(`报批待办：${pendingApprovals.map(item => item.taskName).join('；')}`)
  return facts
}

function buildFallback(projectName: string, facts: string[]) {
  if (!facts.length) return `${projectName}最近一周暂无已记录的任务、风险、里程碑、协调或报批变化。`
  return facts.slice(0, 3).join('；') + '。'
}

import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { approvalItems, coordinationItems, deliveryMeetingTodoImports, deliveryMeetingTodos, milestones, projectPhases, projects, risks, taskDependencies, tasks } from '../../db/schema.ts'
import type { DeepSeekHarnessClient } from '../../ai/deepseek-harness.ts'

export type ProjectChangeInsight = { title: string; detail: string; level: 'critical' | 'warning' | 'info' | 'progress'; category: string; evidence: string[] }
export type ProjectChangeAnalysis = { items: ProjectChangeInsight[]; source: 'model' | 'rules'; generatedAt: string; latestBatch?: { id: string; sourceName: string; importedAt: string }; previousBatch?: { id: string; sourceName: string; importedAt: string }; facts: string[] }

type MeetingTodo = typeof deliveryMeetingTodos.$inferSelect
const modelRefreshes = new Map<string, Promise<void>>()

export async function getProjectChangeAnalysis(projectId: string, harness?: DeepSeekHarnessClient): Promise<ProjectChangeAnalysis | undefined> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) return undefined
  const batches = await db.select().from(deliveryMeetingTodoImports).orderBy(desc(deliveryMeetingTodoImports.importedAt), desc(deliveryMeetingTodoImports.id)).limit(2)
  const batchIds = batches.map(row => row.id)
  const [meetingRows, taskRows, dependencyRows, phaseRows, milestoneRows, riskRows, coordinationRows, approvalRows] = await Promise.all([
    batchIds.length ? db.select().from(deliveryMeetingTodos).where(and(eq(deliveryMeetingTodos.projectId, projectId), inArray(deliveryMeetingTodos.importId, batchIds))).orderBy(asc(deliveryMeetingTodos.sourceRow)) : Promise.resolve([]),
    db.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.isCurrent, true))),
    db.select().from(taskDependencies),
    db.select().from(projectPhases).where(and(eq(projectPhases.projectId, projectId), eq(projectPhases.isCurrent, true))).orderBy(asc(projectPhases.sortOrder)),
    db.select().from(milestones).where(eq(milestones.projectId, projectId)).orderBy(asc(milestones.plannedDate)),
    db.select().from(risks).where(eq(risks.projectId, projectId)),
    db.select().from(coordinationItems).where(eq(coordinationItems.projectId, projectId)),
    db.select().from(approvalItems).where(eq(approvalItems.projectId, projectId)),
  ])
  const latestTodos = meetingRows.filter(row => row.importId === batches[0]?.id)
  const previousTodos = meetingRows.filter(row => row.importId === batches[1]?.id)
  const weeklyText = readWeeklyCompletion(project.metadata)
  const facts = buildFacts(project, latestTodos, previousTodos, weeklyText, taskRows, dependencyRows, phaseRows, milestoneRows, riskRows, coordinationRows, approvalRows)
  const fallback = buildRuleInsights(project, latestTodos, previousTodos, weeklyText, taskRows, dependencyRows, milestoneRows, riskRows, coordinationRows, approvalRows)
  const fingerprint = createHash('sha256').update(JSON.stringify({ analyzerVersion: 3, model: harness?.selection, project: { progress: project.progress, status: project.status }, batches: batches.map(row => [row.id, row.updatedAt]), meetingRows: meetingRows.map(row => [row.id, row.status, row.dueDate, row.updatedAt]), weeklyText, tasks: taskRows.map(row => [row.id, row.status, row.progress, row.updatedAt]), milestones: milestoneRows.map(row => [row.id, row.status, row.plannedDate, row.updatedAt]), risks: riskRows.map(row => [row.id, row.status, row.level, row.updatedAt]), coordination: coordinationRows.map(row => [row.id, row.status, row.updatedAt]), approvals: approvalRows.map(row => [row.id, row.status, row.updatedAt]) })).digest('hex')
  const cached = readCache(project.metadata, fingerprint)
  const base = { generatedAt: new Date().toISOString(), latestBatch: batchInfo(batches[0]), previousBatch: batchInfo(batches[1]), facts }
  if (cached?.source === 'model') return { ...base, items: cached.items, source: 'model' }
  const result = cached ? { ...base, items: cached.items, source: cached.source } : await cacheAndReturn(project, fingerprint, fallback, 'rules', base)
  if (harness && facts.length) startModelRefresh(project, fingerprint, facts, base, harness)
  return result
}

function startModelRefresh(project: typeof projects.$inferSelect, fingerprint: string, facts: string[], base: Omit<ProjectChangeAnalysis,'items'|'source'>, harness: DeepSeekHarnessClient) {
  const key = `${project.id}:${fingerprint}`
  if (modelRefreshes.has(key)) return
  const run = (async () => { let sessionId: string|undefined; try { const session=await harness.createSession();sessionId=session.sessionId;const prompt=`你是项目全生命周期管控专家。根据下列事实，为“${project.name}”输出项目变化提示。要求：1.只依据事实，不新增人物、日期、数字或结论；2.已完成/已关闭事项不得作为关注风险，但可用于整体进展成果；3.优先输出整体进展，再指出连续两批未解决、明确逾期、里程碑受阻、依赖阻塞、高风险、协调和报批；4.输出JSON数组，每项含title、detail、level、category、evidence；level只能是critical/warning/info/progress；evidence为事实原句数组；最多10项，不要Markdown。\n事实：\n${facts.map(value=>`- ${value}`).join('\n')}`;const controller=new AbortController();const response=await withTimeout(harness.promptAndWait(session.sessionId,prompt,0,controller.signal),90_000,()=>controller.abort());const items=parseInsights(response.text);if(items.length)await cacheAndReturn(project,fingerprint,items,'model',base)}catch{if(sessionId)await harness.cancel(sessionId).catch(()=>undefined)}finally{if(sessionId)await harness.archive(sessionId);modelRefreshes.delete(key)} })()
  modelRefreshes.set(key, run)
}

function buildFacts(project: typeof projects.$inferSelect, latest: MeetingTodo[], previous: MeetingTodo[], weeklyText: string, taskRows: Array<typeof tasks.$inferSelect>, dependencies: Array<typeof taskDependencies.$inferSelect>, phases: Array<typeof projectPhases.$inferSelect>, milestoneRows: Array<typeof milestones.$inferSelect>, riskRows: Array<typeof risks.$inferSelect>, coordinationRows: Array<typeof coordinationItems.$inferSelect>, approvalRows: Array<typeof approvalItems.$inferSelect>) {
  const facts: string[] = [`项目整体进度${Math.round(project.progress)}%，状态${project.status}`]
  if (weeklyText) facts.push(`最新本周完成情况：${weeklyText.slice(0, 1800)}`)
  const unresolved = latest.filter(row => !isDone(row.status))
  if (latest.length) facts.push(`最新周会待办共${latest.length}项，未完成${unresolved.length}项，已完成${latest.length - unresolved.length}项`)
  for (const row of unresolved) facts.push(`最新待办：${row.title}；状态${row.status}；截止${row.dueDate ?? row.deadlineText ?? '未明确'}；责任人${row.ownerName ?? '未明确'}`)
  const repeated = repeatedUnresolved(latest, previous)
  for (const row of repeated) facts.push(`连续两批未解决：${row.title}；当前状态${row.status}；截止${row.dueDate ?? row.deadlineText ?? '未明确'}`)
  const activeTasks = taskRows.filter(row => !isDone(row.status))
  const taskIds = new Set(taskRows.map(row => row.id))
  const blockedEdges = dependencies.filter(edge => taskIds.has(edge.predecessorId) && taskIds.has(edge.successorId)).filter(edge => activeTasks.some(row => row.id === edge.predecessorId && ['blocked','delayed'].includes(row.status)))
  for (const row of activeTasks.filter(item => ['blocked','delayed'].includes(item.status)).slice(0, 6)) facts.push(`WBS异常：${row.wbsCode} ${row.name}；状态${row.status}；进度${row.progress}%；计划完成${row.plannedEndDate ?? '未明确'}`)
  if (blockedEdges.length) facts.push(`存在${blockedEdges.length}条由延期或阻塞前置任务影响的依赖链`)
  for (const row of milestoneRows.filter(item => !['completed','cancelled'].includes(item.status)).slice(0, 6)) facts.push(`待推进里程碑：${row.name}；状态${row.status}；计划${row.plannedDate}`)
  for (const row of riskRows.filter(item => !['closed','accepted'].includes(item.status)).slice(0, 6)) facts.push(`活动风险：${row.name}；等级${row.level}；状态${row.status}；预计解决${row.expectedResolutionDate ?? '未明确'}`)
  for (const row of coordinationRows.filter(item => !['resolved','closed'].includes(item.status)).slice(0, 5)) facts.push(`待协调：${row.title}；优先级${row.priority}；截止${row.dueDate ?? '未明确'}`)
  for (const row of approvalRows.filter(item => !['completed','closed','cancelled'].includes(item.status)).slice(0, 5)) facts.push(`待报批：${row.stageName}/${row.taskName}；状态${row.status}；计划完成${row.plannedEndDate ?? '未明确'}`)
  if (phases.length) facts.push(`阶段进度：${phases.map(row => `${row.name}${Math.round(row.progress)}%(${row.status})`).join('；')}`)
  return facts
}

function buildRuleInsights(project: typeof projects.$inferSelect, latest: MeetingTodo[], previous: MeetingTodo[], weeklyText: string, taskRows: Array<typeof tasks.$inferSelect>, dependencies: Array<typeof taskDependencies.$inferSelect>, milestoneRows: Array<typeof milestones.$inferSelect>, riskRows: Array<typeof risks.$inferSelect>, coordinationRows: Array<typeof coordinationItems.$inferSelect>, approvalRows: Array<typeof approvalItems.$inferSelect>): ProjectChangeInsight[] {
  const now = new Date(); const today = now.toISOString().slice(0, 10); const soon = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10); const insights: ProjectChangeInsight[] = []
  const unresolved = latest.filter(row => !isDone(row.status)); const repeated = repeatedUnresolved(latest, previous); const overdue = unresolved.filter(row => row.dueDate && row.dueDate < today); const upcoming = unresolved.filter(row => row.dueDate && row.dueDate >= today && row.dueDate <= soon)
  const activeRisks = riskRows.filter(row => !['closed','accepted'].includes(row.status)); const delayedTasks = taskRows.filter(row => ['blocked','delayed'].includes(row.status)); const pendingMilestones = milestoneRows.filter(row => !['completed','cancelled'].includes(row.status));
  insights.push({ title: '项目整体推进概况', detail: `${project.name}当前整体进度${Math.round(project.progress)}%。最新周会待办${latest.length}项，已完成${latest.length - unresolved.length}项、未完成${unresolved.length}项；另有${delayedTasks.length}项WBS延期或阻塞、${activeRisks.length}项活动风险。`, level: overdue.length || repeated.length ? 'warning' : 'progress', category: '整体进展', evidence: [`项目进度：${Math.round(project.progress)}%`, `周会待办：完成${latest.length - unresolved.length}项/未完成${unresolved.length}项`, `WBS延期或阻塞：${delayedTasks.length}项`, `活动风险：${activeRisks.length}项`, ...(weeklyText ? [weeklyText.slice(0,300)] : [])] })
  if (repeated.length) insights.push({ title: '连续两周待办未解决', detail: `有${repeated.length}项待办连续两个导入批次仍未关闭，需优先核实阻塞原因、责任人和新的完成节点。重点包括：${repeated.slice(0,3).map(row=>row.title).join('；')}。`, level: 'critical', category: '连续未解决', evidence: repeated.slice(0,5).map(row=>`${row.title}｜${statusText(row.status)}｜${row.dueDate ?? row.deadlineText ?? '节点未明确'}`) })
  if (overdue.length || upcoming.length) insights.push({ title: overdue.length ? '周会待办存在逾期' : '周会待办临近截止', detail: `${overdue.length ? `${overdue.length}项待办已过截止日期` : '暂无逾期待办'}，${upcoming.length}项将在7天内到期；已完成事项不列入关注。${overdue[0] ? `首要关注：${overdue[0].title}。` : upcoming[0] ? `近期关注：${upcoming[0].title}。` : ''}`, level: overdue.length ? 'critical' : 'warning', category: overdue.length ? '逾期待办' : '临期待办', evidence: [...overdue.slice(0,3).map(row=>`${row.title}｜逾期｜${row.dueDate}`), ...upcoming.slice(0,2).map(row=>`${row.title}｜${row.dueDate}到期`)] })
  const taskMap = new Map(taskRows.map(row => [row.id,row])); const projectTaskIds = new Set(taskMap.keys()); const blockedEdges = dependencies.filter(row=>projectTaskIds.has(row.predecessorId)&&projectTaskIds.has(row.successorId)).map(row=>({before:taskMap.get(row.predecessorId),after:taskMap.get(row.successorId)})).filter(row=>row.before&&row.after&&['blocked','delayed'].includes(row.before.status)&&!isDone(row.after.status))
  if (blockedEdges.length) insights.push({ title: '前置任务影响后续计划', detail: `识别到${blockedEdges.length}条由延期或阻塞前置任务影响的依赖链，需先解除前置约束，避免继续传导到后续任务和里程碑。`, level: 'critical', category: '依赖阻塞', evidence: blockedEdges.slice(0,5).map(row=>`${row.before!.wbsCode} ${row.before!.name} → ${row.after!.wbsCode} ${row.after!.name}`) })
  const overdueMilestones = pendingMilestones.filter(row=>row.plannedDate<today); if(overdueMilestones.length) insights.push({ title:'里程碑节点需要校准', detail:`${overdueMilestones.length}个未完成里程碑的计划日期已过，需确认实际达成情况、补齐依据或调整项目基线。重点：${overdueMilestones.slice(0,2).map(row=>row.name).join('；')}。`, level:'critical', category:'里程碑', evidence:overdueMilestones.slice(0,5).map(row=>`${row.name}｜计划${row.plannedDate}｜${statusText(row.status)}`) })
  const highRisks=activeRisks.filter(row=>['critical','high'].includes(row.level)); if(highRisks.length) insights.push({title:'高风险仍在跟进',detail:`当前有${highRisks.length}项高或严重风险未关闭，需结合周会待办确认应对措施、责任人和解决日期是否落实。`,level:'warning',category:'风险',evidence:highRisks.slice(0,5).map(row=>`${row.name}｜${row.level}｜预计解决${row.expectedResolutionDate ?? '未明确'}`)})
  if (weeklyText) insights.push({ title:'本周完成与后续衔接', detail:`本周已记录阶段成果；需将完成情况与未关闭周会待办、后续WBS和里程碑逐项衔接，避免“已完成说明”与计划状态不一致。`, level:'progress', category:'计划衔接', evidence:[weeklyText.slice(0,500)] })
  const pendingCoordination=coordinationRows.filter(row=>!['resolved','closed'].includes(row.status)); if(pendingCoordination.length) insights.push({title:'跨部门协调事项待推进',detail:`当前仍有${pendingCoordination.length}项协调事项未关闭，优先关注${[...pendingCoordination].sort((a,b)=>priorityScore(b.priority)-priorityScore(a.priority))[0]!.title}。`,level:'warning',category:'协调',evidence:pendingCoordination.slice(0,5).map(row=>row.title)})
  const pendingApproval=approvalRows.filter(row=>!['completed','closed','cancelled'].includes(row.status)); if(pendingApproval.length) insights.push({title:'立项报批仍有未完成节点',detail:`当前仍有${pendingApproval.length}项报批节点未完成，需结合项目阶段和里程碑确认是否形成前置约束。`,level:'info',category:'报批',evidence:pendingApproval.slice(0,5).map(row=>`${row.stageName}/${row.taskName}`)})
  return dedupe(insights).slice(0,12)
}

function repeatedUnresolved(latest: MeetingTodo[], previous: MeetingTodo[]) { const prior = new Set(previous.filter(row => !isDone(row.status)).map(row => normalizeTitle(row.title))); return latest.filter(row => !isDone(row.status) && prior.has(normalizeTitle(row.title))) }
function normalizeTitle(value: string) { return value.toLowerCase().replace(/[\s，,。；;：:（）()【】\[\]“”"']/g, '') }
function isDone(status: string) { return ['completed','closed'].includes(status) }
function priorityScore(value: string) { return value === 'critical' ? 4 : value === 'high' ? 3 : value === 'medium' ? 2 : 1 }
function statusText(value: string) { return ({ pending:'待处理', in_progress:'进行中', paused:'暂停', blocked:'阻塞', delayed:'延期', completed:'已完成', closed:'已关闭', not_started:'未开始', ready:'待启动', following:'跟进中', identified:'已识别' } as Record<string,string>)[value] ?? value }
function readWeeklyCompletion(metadata: Record<string, unknown>) { const value = metadata.latestWeeklyCompletion; return value && typeof value === 'object' && typeof (value as any).text === 'string' ? String((value as any).text).trim() : '' }
function batchInfo(row?: typeof deliveryMeetingTodoImports.$inferSelect) { return row ? { id: row.id, sourceName: row.sourceName, importedAt: row.importedAt.toISOString() } : undefined }
function dedupe(items: ProjectChangeInsight[]) { const seen = new Set<string>(); return items.filter(item => { const key = `${item.category}:${normalizeTitle(item.detail)}`; if (seen.has(key)) return false; seen.add(key); return true }) }
function parseInsights(value: string): ProjectChangeInsight[] { try { const raw = JSON.parse(value.match(/\[[\s\S]*\]/)?.[0] ?? value); if (!Array.isArray(raw)) return []; return raw.filter(item => item && typeof item.title === 'string' && typeof item.detail === 'string' && ['critical','warning','info','progress'].includes(item.level)).map(item => ({ title: item.title.trim().slice(0,40), detail: item.detail.trim().slice(0,600), level: item.level, category: typeof item.category === 'string' ? item.category.trim().slice(0,30) : '综合分析', evidence: Array.isArray(item.evidence) ? item.evidence.filter((x:unknown):x is string=>typeof x==='string').slice(0,5) : [] })).filter(item => item.title && item.detail) } catch { return [] } }
function readCache(metadata: Record<string, unknown>, fingerprint: string) { const value = metadata.projectChangeAnalysis; if (!value || typeof value !== 'object' || (value as any).fingerprint !== fingerprint || !Array.isArray((value as any).items)) return undefined; const items = parseInsights(JSON.stringify((value as any).items)); return items.length ? { items, source: (value as any).source === 'model' ? 'model' as const : 'rules' as const } : undefined }
async function cacheAndReturn(project: typeof projects.$inferSelect, fingerprint: string, items: ProjectChangeInsight[], source: 'model'|'rules', base: Omit<ProjectChangeAnalysis,'items'|'source'>): Promise<ProjectChangeAnalysis> { const cache={ fingerprint,items,source,generatedAt:base.generatedAt };await db.update(projects).set({ metadata: sql`coalesce(${projects.metadata},'{}'::jsonb) || jsonb_build_object('projectChangeAnalysis',${JSON.stringify(cache)}::jsonb)` }).where(eq(projects.id,project.id));return { ...base,items,source } }
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void) { let timer: ReturnType<typeof setTimeout>|undefined; try { return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>{onTimeout();reject(new Error('project_change_analysis_timeout'))},ms)})]) } finally { if(timer)clearTimeout(timer) } }

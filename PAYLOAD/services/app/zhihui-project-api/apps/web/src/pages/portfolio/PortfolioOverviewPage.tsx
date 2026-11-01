import { Button, Card, Message, Progress, Space, Tag, Typography } from '@arco-design/web-react'
import { IconApps, IconCalendar, IconCheckCircle, IconDownload, IconExclamationCircle, IconFile, IconRight, IconRobot, IconShake, IconThunderbolt } from '@arco-design/web-react/icon'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { getPortfolioSummary, getProjectHealthSummary, peekPortfolioSummary, type ProjectHealthSummary, type PortfolioProject, type PortfolioSummary, type ProjectHealth } from '../../api/projects.ts'
import { EmptyState, ErrorState, LoadingState } from '../../components/feedback/index.ts'
import { StatusTag } from '../../components/ui/index.ts'
import { ApiError } from '../../lib/api-client.ts'
import { downloadCsv } from '../../lib/csv.ts'

export function PortfolioOverviewPage() {
  const navigate = useNavigate(); const cachedSummary=peekPortfolioSummary(); const [summary, setSummary] = useState<PortfolioSummary|undefined>(cachedSummary); const [loading, setLoading] = useState(!cachedSummary); const [error, setError] = useState<string>(); const [healthSummaries, setHealthSummaries] = useState<Record<string,ProjectHealthSummary>>({}); const [changeFilter, setChangeFilter] = useState<'all' | 'risk' | 'coordination' | 'milestone'>('all')
  const load = useCallback(async () => { setLoading(true); setError(undefined); try { setSummary(await getPortfolioSummary()) } catch (reason) { setError(reason instanceof ApiError ? reason.message : '项目组合数据加载失败') } finally { setLoading(false) } }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (!summary?.projects.length) return; let alive = true; let refreshes=0; const fetchSummaries=async()=>{const entries=await Promise.all(summary.projects.map(async project => [project.id, await getProjectHealthSummary(project.id,refreshes>0)] as const));if(alive)setHealthSummaries(Object.fromEntries(entries))};void fetchSummaries().catch(()=>undefined);const timer=setInterval(()=>{refreshes++;void fetchSummaries().catch(()=>undefined);if(refreshes>=18)clearInterval(timer)},5000);return () => { alive = false;clearInterval(timer) } }, [summary])
  if (loading && !summary) return <LoadingState title="正在加载项目总览" description="正在汇总项目、风险、里程碑和协调事项。" />
  if (error) return <ErrorState description={error} onRetry={load} />
  if (!summary || summary.counts.managedProjects === 0) return <EmptyState title="暂无在管项目" description="已归档项目不会出现在项目总览中。" actionLabel="查看项目列表" onAction={() => navigate('/projects')} />

  const orderedProjects = [...summary.projects].sort(compareProject)
  const averageProgress = Math.round(orderedProjects.reduce((total, project) => total + project.progress, 0) / orderedProjects.length)
  const changes = buildChanges(orderedProjects)
  const visibleChanges = changeFilter === 'all' ? changes : changes.filter(item => item.type === changeFilter)
  const primaryProjectId = orderedProjects[0]?.id
  const exportCsv = () => { downloadCsv('项目组合当前摘要.csv', ['项目编号','项目名称','状态','健康度','进度','活动风险','待协调事项','临近里程碑','计划结束日期'], orderedProjects.map(project => [project.code,project.name,project.status,project.effectiveHealth,project.progress,project.activeRiskCount,project.pendingCoordinationCount,project.upcomingMilestoneCount,project.plannedEndDate ?? ''])); Message.success('已导出当前项目组合摘要') }

  return <div className="portfolio-overview prototype-overview">
    <header className="portfolio-overview__heading"><div><Typography.Title heading={3}>项目总览</Typography.Title><Typography.Paragraph type="secondary">在管项目组合总览 · {summary.counts.managedProjects} 个项目（建设中 {summary.counts.inProgressProjects} · 规划立项 {summary.counts.planningProjects}）· 数据截至 {formatDateTime(summary.generatedAt)}</Typography.Paragraph></div><Space><Button icon={<IconDownload />} onClick={exportCsv}>导出当前摘要</Button><Button type="primary" icon={<IconFile />} disabled={!primaryProjectId} onClick={() => primaryProjectId && navigate(`/projects/${primaryProjectId}/approvals`)}>立项报批进度</Button></Space></header>

    <section className="prototype-overview__stats">
      <OverviewStat tone="blue" icon={<IconApps />} value={summary.counts.managedProjects} label="在管项目总数" detail={`组合整体进度 ${averageProgress}% · 健康 ${summary.counts.healthyProjects} · 需关注 ${summary.counts.attentionProjects} · 高风险 ${summary.counts.riskProjects}`} />
      <OverviewStat tone="cyan" icon={<IconCalendar />} value={summary.counts.upcomingMilestones} label={`${summary.upcomingMilestoneDays} 天内临近里程碑`} detail="统计未完成且计划日期临近的关键节点" />
      <OverviewStat tone="red" icon={<IconExclamationCircle />} value={summary.counts.keyRisks} label="关键风险与问题" detail="未关闭的高风险与严重风险" />
      <OverviewStat tone="orange" icon={<IconShake />} value={summary.counts.pendingCoordinationItems} label="待协调事项" detail="未解决或未关闭的跨方协调事项" />
    </section>

    <section className="prototype-overview__layout">
      <Card className="prototype-project-panel" title={<div><div className="prototype-card-title"><IconApps />项目健康度总览</div><small>{summary.counts.managedProjects} 个在管项目 · 按健康度与整体进度排序 · 点击卡片进入项目详细任务</small></div>} extra={<div className="prototype-health-legend"><Legend color="#00b42a" label="健康" /><Legend color="#ff7d00" label="需关注" /><Legend color="#f53f3f" label="高风险" /></div>}>
        <div className="prototype-project-grid">{orderedProjects.map(project => <ProjectOverviewCard key={project.id} project={project} aiSummary={healthSummaries[project.id]?.summary} aiSource={healthSummaries[project.id]?.source} onOpen={() => navigate(`/projects/${project.id}/tasks`)} />)}</div>
      </Card>

      <aside className="prototype-overview__side">
        <Card className="prototype-insight-card"><div className="prototype-insight-head"><span className="prototype-ai-avatar"><IconRobot /></span><div><b>AI 洞察分析</b><small>基于 {summary.counts.managedProjects} 个项目 · {summary.counts.keyRisks} 项关键风险 · {summary.counts.pendingCoordinationItems} 项协调事项</small></div></div><div className="prototype-insight-list"><Insight icon="📌" title="组合进展">在管项目平均进度 {averageProgress}%；当前健康 {summary.counts.healthyProjects} 个、需关注 {summary.counts.attentionProjects} 个、高风险 {summary.counts.riskProjects} 个。</Insight><Insight icon="⚠️" title="重点风险">{topRiskText(orderedProjects)}</Insight><Insight icon="💡" title="综合建议">优先处理高风险项目的首要健康度原因，并同步跟进临近里程碑和逾期协调事项。</Insight></div><button className="prototype-insight-link" type="button" disabled={!primaryProjectId} onClick={() => primaryProjectId && navigate(`/projects/${primaryProjectId}/ai`)}><IconThunderbolt />需要完整分析？前往项目智能助手一键生成周报 <IconRight /></button></Card>
        <Card className="prototype-change-card" title={<div><div className="prototype-card-title"><IconCalendar />组合关注摘要</div><small>由当前真实项目汇总数据自动生成</small></div>}><div className="prototype-change-filters">{([['all','全部'],['risk','风险'],['coordination','协调'],['milestone','里程碑']] as const).map(([value, label]) => <button className={changeFilter === value ? 'active' : ''} key={value} type="button" onClick={() => setChangeFilter(value)}>{label}</button>)}</div><div className="prototype-change-list">{visibleChanges.length ? visibleChanges.map(item => <button type="button" className="prototype-change-item" key={item.id} onClick={() => navigate(item.path)}><span className={`prototype-change-tag prototype-change-tag--${item.type}`}>{item.label}</span><span><b>{item.project}</b>：{item.text}<small>{item.meta}</small></span></button>) : <div className="prototype-change-empty">当前分类暂无需要关注的事项</div>}</div></Card>
      </aside>
    </section>
  </div>
}

function OverviewStat({ tone, icon, value, label, detail }: { tone: string; icon: ReactNode; value: number; label: string; detail: string }) { return <div className="prototype-stat-card"><span className={`prototype-stat-icon prototype-stat-icon--${tone}`}>{icon}</span><div><strong>{value}</strong><b>{label}</b><small>{detail}</small></div></div> }
function Legend({ color, label }: { color: string; label: string }) { return <span><i style={{ background: color }} />{label}</span> }
function Insight({ icon, title, children }: { icon: string; title: string; children: ReactNode }) { return <div className="prototype-insight-item"><span>{icon}</span><div><b>{title}</b>：{children}</div></div> }

function ProjectOverviewCard({ project, aiSummary, aiSource, onOpen }: { project: PortfolioProject; aiSummary?: string; aiSource?: 'model'|'rules'; onOpen: () => void }) {
  const tone = project.effectiveHealth; const statusLabel = projectStatusLabel(project.status); const issueText = aiSummary ?? '正在归纳项目详细任务的 AI 变化提示…'
  return <button type="button" className={`prototype-project-card prototype-project-card--${tone}`} onClick={onOpen}><div className="prototype-project-head"><span className="prototype-health-dot" /><b>{project.name}</b><StatusTag value={project.status} label={statusLabel} /></div><div className="prototype-project-meta"><Tag color="arcoblue">{project.category || project.code}</Tag><span>{project.clientName || '未填写客户单位'}{project.plannedEndDate ? ` · 计划至 ${project.plannedEndDate}` : ''}</span></div><div className={`prototype-project-issue prototype-project-issue--${tone}`}>{tone === 'healthy' ? <IconCheckCircle /> : <IconExclamationCircle />}<span title={issueText}>{issueText}<small> · {aiSource==='model'?'模型分析':'规则兜底 / 等待模型'}</small></span></div><div className="prototype-project-progress"><span>整体进度</span><Progress percent={project.progress} size="small" showText={false} color={progressColor(project.progress)} /><b>{project.progressPrevious !== null && project.progressPrevious !== project.progress ? `${project.progressPrevious}%→${project.progress}%` : `${project.progress}%`}</b></div><div className="prototype-project-foot"><span>风险 {project.activeRiskCount} · 协调 {project.pendingCoordinationCount} · 临近里程碑 {project.upcomingMilestoneCount}</span><em>查看项目任务 <IconRight /></em></div></button>
}

type ChangeItem = { id: string; type: 'risk' | 'coordination' | 'milestone'; label: string; project: string; text: string; meta: string; path: string }
function buildChanges(projects: PortfolioProject[]): ChangeItem[] { const result: ChangeItem[] = []; for (const project of projects) { if (project.activeRiskCount) result.push({ id: `${project.id}-risk`, type: 'risk', label: '风险', project: project.name, text: `${project.activeRiskCount} 项活动风险，${project.healthReasons.find(item => item.code.includes('risk'))?.label ?? '请进入项目查看风险明细'}`, meta: '项目风险', path: `/projects/${project.id}/risks` }); if (project.pendingCoordinationCount) result.push({ id: `${project.id}-coord`, type: 'coordination', label: '协调', project: project.name, text: `${project.pendingCoordinationCount} 项待协调事项需要跟进`, meta: '协调事项', path: `/projects/${project.id}/coordination` }); if (project.upcomingMilestoneCount) result.push({ id: `${project.id}-ms`, type: 'milestone', label: '节点', project: project.name, text: `${project.upcomingMilestoneCount} 个里程碑将在 7 天内到期`, meta: '里程碑', path: `/projects/${project.id}/milestones` }) } return result.sort((a, b) => changeScore(a.type) - changeScore(b.type)).slice(0, 8) }
function topRiskText(projects: PortfolioProject[]) { const project = projects.find(item => item.effectiveHealth === 'risk') ?? projects.find(item => item.effectiveHealth === 'attention'); return project ? `${project.name}：${project.healthReasons[0]?.label ?? '存在需要关注的项目健康度信号'}。` : '当前没有项目触发高风险或需关注规则。' }
function compareProject(a: PortfolioProject, b: PortfolioProject) { return healthScore(b.effectiveHealth) - healthScore(a.effectiveHealth) || b.activeRiskCount - a.activeRiskCount || b.progress - a.progress }
function healthScore(value: ProjectHealth) { return value === 'risk' ? 2 : value === 'attention' ? 1 : 0 }
function changeScore(value: ChangeItem['type']) { return value === 'risk' ? 0 : value === 'coordination' ? 1 : 2 }
function healthColor(value: ProjectHealth) { return value === 'risk' ? '#f53f3f' : value === 'attention' ? '#ff7d00' : '#00b42a' }
function progressColor(value: number) { return value >= 80 ? '#00b42a' : value >= 50 ? '#095aff' : value >= 25 ? '#ff7d00' : '#f53f3f' }
function projectStatusLabel(status: PortfolioProject['status']) { return status === 'planning' ? '规划立项' : status === 'in_progress' ? '建设中' : status === 'on_hold' ? '已暂停' : status === 'completed' ? '已完成' : '已归档' }
function formatDateTime(value: string) { const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date) }

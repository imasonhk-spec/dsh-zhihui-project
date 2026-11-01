import { Grid, Link, Space, Typography } from '@arco-design/web-react'
import { IconBook, IconCalendar, IconCheckCircle, IconExclamationCircle, IconRight, IconShake, IconStorage } from '@arco-design/web-react/icon'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getProjectOverview, type ProjectOverviewDetail } from '../../api/projects.ts'
import { EmptyState, ErrorState, LoadingState } from '../../components/feedback/index.ts'
import { DataPanel, ProgressBar, StatCard, StatusTag } from '../../components/ui/index.ts'
import { ApiError } from '../../lib/api-client.ts'

const { Row: GridRow, Col: GridCol } = Grid

export function ProjectDetailPage() {
  const navigate = useNavigate()
  const { projectId } = useParams<{ projectId: string }>()
  const [overview, setOverview] = useState<ProjectOverviewDetail>()
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    if (!projectId) return
    setLoading(true); setError(undefined); setNotFound(false)
    try { setOverview(await getProjectOverview(projectId)) }
    catch (reason) { if (reason instanceof ApiError && reason.status === 404) setNotFound(true); else setError(reason instanceof ApiError ? reason.message : '项目详情加载失败') }
    finally { setLoading(false) }
  }, [projectId])
  useEffect(() => { void load() }, [load])
  if (loading) return <LoadingState title="正在加载项目详情" description="正在汇总项目基础信息与执行摘要。" />
  if (notFound) return <EmptyState title="项目不存在" description="该项目可能已删除，或访问地址不正确。" actionLabel="返回项目列表" onAction={() => navigate('/projects')} />
  if (error) return <ErrorState description={error} onRetry={load} />
  if (!overview) return null
  const { project, counts } = overview
  const go = (path: string) => navigate(`/projects/${project.id}${path}`)
  return <div className="project-detail-page">
    <section className="project-detail-hero">
      <div className="project-detail-hero__main">
        <Space size={8}><Typography.Text type="secondary">{project.code}</Typography.Text><StatusTag value={project.status} /><StatusTag value={project.effectiveHealth} /></Space>
        <Typography.Title heading={3}>{project.name}</Typography.Title>
        <Typography.Text type="secondary">{[project.category, project.clientName].filter(Boolean).join(' · ') || '未设置项目分类和客户单位'}</Typography.Text>
        <div className="project-detail-hero__dates"><span>计划：{formatDate(project.startDate)} 至 {formatDate(project.plannedEndDate)}</span>{project.actualEndDate ? <span>实际完成：{formatDate(project.actualEndDate)}</span> : null}</div>
      </div>
      <div className="project-detail-hero__progress"><ProgressBar value={project.progress} label="总体进度" /><Typography.Text type="secondary">{project.healthReasons[0]?.label ?? '当前未触发自动预警规则'}</Typography.Text></div>
    </section>
    <GridRow gutter={16}><GridCol span={6}><StatCard title="进行中任务" value={counts.activeTasks} icon={<IconCheckCircle />} /></GridCol><GridCol span={6}><StatCard title="延期任务" value={counts.delayedTasks} tone="orange" icon={<IconExclamationCircle />} /></GridCol><GridCol span={6}><StatCard title="活动风险" value={counts.activeRisks} tone="red" icon={<IconExclamationCircle />} /></GridCol><GridCol span={6}><StatCard title="待协调事项" value={counts.pendingCoordinationItems} tone="purple" icon={<IconShake />} /></GridCol></GridRow>
    <DataPanel title="项目阶段" description="按项目执行阶段排序" extra={<Link onClick={() => go('/imports')}>导入任务 <IconRight /></Link>}><PhaseSummary phases={overview.phases} /></DataPanel>
    <GridRow gutter={16}>
      <GridCol span={12}><SummaryPanel title="风险摘要" description="未关闭或未接受风险，最多展示 5 项" linkLabel="查看全部风险" onOpen={() => go('/risks')} emptyText="暂无活动风险"><RiskList items={overview.risks} onOpen={item => go(`/risks?level=${item.level}`)} /></SummaryPanel></GridCol>
      <GridCol span={12}><SummaryPanel title="里程碑摘要" description="优先展示延期和近期未完成节点，最多展示 5 项" linkLabel="查看全部里程碑" onOpen={() => go('/milestones')} emptyText="暂未设置里程碑"><MilestoneList items={overview.milestones} /></SummaryPanel></GridCol>
    </GridRow>
    <SummaryPanel title="协调事项摘要" description="优先展示高优先级、未解决事项，最多展示 5 项" linkLabel="查看全部协调事项" onOpen={() => go('/coordination')} emptyText="暂无待协调事项"><CoordinationList items={overview.coordinationItems} onOpen={item => go(`/coordination?priority=${item.priority}`)} /></SummaryPanel>
    <ApprovalSummary summary={overview.approvalSummary} onOpen={path => go(`/approvals${path}`)} />
    <KnowledgeSummary summary={overview.knowledgeSummary} onOpen={path => go(`/knowledge${path}`)} />
  </div>
}

function PhaseSummary({ phases }: { phases: ProjectOverviewDetail['phases'] }) {
  if (!phases.length) return <InlineEmpty text="暂未设置项目阶段" />
  return <div className="phase-summary">{phases.map(phase => <div className="phase-summary__item" key={phase.id}><div className="phase-summary__top"><Space><Typography.Text type="secondary">{phase.code}</Typography.Text><Typography.Text bold>{phase.name}</Typography.Text><StatusTag value={phase.status} /></Space><Typography.Text>{phase.progress}%</Typography.Text></div><ProgressBar value={phase.progress} showText={false} /><Typography.Text type="secondary">{formatDate(phase.plannedStartDate)} 至 {formatDate(phase.plannedEndDate)}</Typography.Text></div>)}</div>
}

function SummaryPanel({ title, description, linkLabel, onOpen, emptyText, children }: { title: string; description: string; linkLabel: string; onOpen: () => void; emptyText: string; children: ReactNode }) {
  const hasItems = Array.isArray(children) ? children.length > 0 : true
  return <DataPanel title={title} description={description} extra={<Link onClick={onOpen}>{linkLabel} <IconRight /></Link>}>{hasItems ? children : <InlineEmpty text={emptyText} />}</DataPanel>
}
function RiskList({ items, onOpen }: { items: ProjectOverviewDetail['risks']; onOpen: (item: ProjectOverviewDetail['risks'][number]) => void }) { return items.map(item => <div className="summary-row summary-row--interactive" key={item.id} role="button" tabIndex={0} onClick={() => onOpen(item)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item) } }}><div><Space><StatusTag value={item.level} /><Typography.Text bold>{item.name}</Typography.Text></Space><Typography.Text type="secondary">{item.code} · {item.ownerName ?? item.source ?? '未指定责任方'}</Typography.Text></div><div className="summary-row__right"><StatusTag value={item.status} /><Typography.Text type="secondary">预计 {formatDate(item.expectedResolutionDate)}</Typography.Text></div></div>) }
function MilestoneList({ items }: { items: ProjectOverviewDetail['milestones'] }) { return items.map(item => <div className="summary-row" key={item.id}><div><Space><StatusTag value={item.status} /><Typography.Text bold>{item.name}</Typography.Text></Space><Typography.Text type="secondary">{item.ownerName ?? '未指定责任人'}</Typography.Text></div><div className="summary-row__right"><Typography.Text>计划 {formatDate(item.plannedDate)}</Typography.Text><Typography.Text type="secondary">{item.actualDate ? `实际 ${formatDate(item.actualDate)}` : item.deliverable ?? '—'}</Typography.Text></div></div>) }
function CoordinationList({ items, onOpen }: { items: ProjectOverviewDetail['coordinationItems']; onOpen: (item: ProjectOverviewDetail['coordinationItems'][number]) => void }) { return items.map(item => <div className="summary-row summary-row--interactive" key={item.id} role="button" tabIndex={0} onClick={() => onOpen(item)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item) } }}><div><Space><StatusTag value={item.priority} /><Typography.Text bold>{item.title}</Typography.Text></Space><Typography.Text type="secondary">{item.code} · {item.category} · {item.ownerName ?? '未指定责任人'}</Typography.Text></div><div className="summary-row__right"><StatusTag value={item.status} /><Typography.Text type="secondary">到期 {formatDate(item.dueDate)} · {item.progress}%</Typography.Text></div></div>) }
function ApprovalSummary({ summary, onOpen }: { summary: ProjectOverviewDetail['approvalSummary']; onOpen: (path: string) => void }) {
  return <DataPanel title="立项报批摘要" description="报批完成率、当前阶段和近期截止任务" extra={<Link onClick={() => onOpen('')}>查看全部报批任务 <IconRight /></Link>}>
    {summary.total ? <div className="approval-summary-panel"><div className="approval-summary-panel__progress"><ProgressBar value={summary.progress} label={`${summary.completed}/${summary.total} 项已完成`} /></div><button type="button" className="summary-row summary-row--interactive" onClick={() => summary.currentStage && onOpen(`?stageCode=${summary.currentStage.stageCode}`)}><div><Typography.Text type="secondary">当前阶段</Typography.Text><Typography.Text bold>{summary.currentStage?.stageName ?? '全部阶段已完成'}</Typography.Text></div><IconRight /></button><button type="button" className="summary-row summary-row--interactive" onClick={() => onOpen('?range=overdue')}><div><Typography.Text type="secondary">逾期报批任务</Typography.Text><Typography.Text bold>{summary.overdue} 项</Typography.Text></div><IconRight /></button><button type="button" className="summary-row summary-row--interactive" onClick={() => onOpen('')}><div><Typography.Text type="secondary">最近截止</Typography.Text><Typography.Text bold>{summary.nextDeadline?.taskName ?? '暂无待办任务'}</Typography.Text><Typography.Text type="secondary">{formatDate(summary.nextDeadline?.plannedEndDate ?? null)}</Typography.Text></div><IconRight /></button><div className="summary-row"><div><Typography.Text type="secondary">预计合同签订</Typography.Text><Typography.Text bold>{formatDate(summary.expectedContractDate)}</Typography.Text></div></div></div> : <InlineEmpty text="暂未设置立项报批任务" />}
  </DataPanel>
}
function KnowledgeSummary({ summary, onOpen }: { summary: ProjectOverviewDetail['knowledgeSummary']; onOpen: (path: string) => void }) {
  return <DataPanel title="项目知识库摘要" description="目录、文档、归档和近期更新情况" extra={<Link onClick={() => onOpen('')}>进入项目知识库 <IconRight /></Link>}>
    <div className="knowledge-project-summary"><button type="button" className="summary-row summary-row--interactive" onClick={() => onOpen('')}><div><Space><IconBook /><Typography.Text type="secondary">知识库目录</Typography.Text></Space><Typography.Text bold>{summary.folders} 个目录</Typography.Text></div><IconRight /></button><button type="button" className="summary-row summary-row--interactive" onClick={() => onOpen('')}><div><Space><IconStorage /><Typography.Text type="secondary">活动文档</Typography.Text></Space><Typography.Text bold>{summary.activeDocuments} / {summary.documents} 份</Typography.Text><Typography.Text type="secondary">{formatBytes(summary.storageBytes)}</Typography.Text></div><IconRight /></button><button type="button" className="summary-row summary-row--interactive" onClick={() => onOpen('?status=archived&includeArchived=true')}><div><Typography.Text type="secondary">已归档文档</Typography.Text><Typography.Text bold>{summary.archivedDocuments} 份</Typography.Text></div><IconRight /></button></div>
    {summary.recentDocuments.length ? <div className="knowledge-project-recent"><Typography.Text bold>最近更新</Typography.Text>{summary.recentDocuments.map(item => <button type="button" className="summary-row summary-row--interactive" key={item.id} onClick={() => onOpen(`?q=${encodeURIComponent(item.name)}`)}><div><Space><StatusTag value={item.status} /><Typography.Text bold>{item.name}</Typography.Text></Space><Typography.Text type="secondary">{item.folderPath ?? '未分类'} · {item.fileType.toUpperCase()} · {item.version}</Typography.Text></div><div className="summary-row__right"><Typography.Text>{formatBytes(item.fileSize ?? 0)}</Typography.Text><Typography.Text type="secondary">{new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })}</Typography.Text></div></button>)}</div> : <InlineEmpty text="知识库暂无文档，可进入知识库上传首份资料" />}
  </DataPanel>
}
function InlineEmpty({ text }: { text: string }) { return <div className="summary-empty"><Typography.Text type="secondary">{text}</Typography.Text></div> }
function formatDate(value: string | null) { return value ?? '—' }
function formatBytes(value: number) { if (!value) return '0 B'; const units=['B','KB','MB','GB']; const level=Math.min(Math.floor(Math.log(value)/Math.log(1024)),units.length-1); const amount=value/1024**level; return `${amount>=10||level===0?amount.toFixed(0):amount.toFixed(1)} ${units[level]}` }

import { Button, Card, Empty, Grid, Input, Space, Table, Tag, Typography, Message } from '@arco-design/web-react'
import { IconDownload, IconRefresh, IconLeft } from '@arco-design/web-react/icon'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getWeeklyReport, type WeeklyReport, type WeeklyReportItem, type WeeklyReportRisk } from '../../api/projects.ts'
import { ErrorState, LoadingState } from '../../components/feedback/index.ts'
import { downloadCsv } from '../../lib/csv.ts'
import { ApiError } from '../../lib/api-client.ts'

const { Row, Col } = Grid

function defaultRange() {
  const today = new Date()
  const day = today.getDay() || 7
  const monday = new Date(today)
  monday.setDate(today.getDate() - day + 1)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return { from: toDate(monday), to: toDate(sunday) }
}
function toDate(value: Date) { return value.toISOString().slice(0, 10) }
function formatDate(value: string | null | undefined) { return value || '—' }
function itemRows(items: WeeklyReportItem[]) { return items.map(item => [item.title, item.ownerName || '', item.status, item.progress ?? '', formatDate(item.plannedDate), formatDate(item.actualDate), item.description || '']) }

export function ProjectWeeklyReportPage() {
  const navigate = useNavigate()
  const { projectId = '' } = useParams<{ projectId: string }>()
  const initial = defaultRange()
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [report, setReport] = useState<WeeklyReport>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    if (!projectId) return
    if (!from || !to) { setError('请选择完整的周报日期范围'); return }
    if (from > to) { setError('开始日期不能晚于结束日期'); return }
    setLoading(true); setError(undefined)
    try { setReport(await getWeeklyReport(projectId, from, to)) }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : '周报加载失败') }
    finally { setLoading(false) }
  }, [from, projectId, to])
  useEffect(() => { void load() }, [load])

  const exportCsv = () => {
    if (!report) return
    const sections: unknown[][] = [
      ['项目周报', report.project.name], ['周期', `${report.from} 至 ${report.to}`], ['周报摘要', report.summary || ''], [],
      ['本周完成事项', '', '', '', '', '', ''], ['事项', '负责人', '状态', '进度', '计划日期', '实际日期', '说明'], ...itemRows(report.completedItems), [],
      ['下周计划事项', '', '', '', '', '', ''], ['事项', '负责人', '状态', '进度', '计划日期', '实际日期', '说明'], ...itemRows(report.plannedItems), [],
      ['风险与问题', '', '', '', '', '', ''], ['事项', '负责人', '等级', '状态', '计划日期', '实际日期', '应对措施'], ...report.risks.map(item => [item.title, item.ownerName || '', item.level, item.status, formatDate(item.plannedDate), formatDate(item.actualDate), item.mitigation || '']), [],
      ['协调事项', '', '', '', '', '', ''], ['事项', '负责人', '状态', '进度', '计划日期', '实际日期', '说明'], ...itemRows(report.coordinationItems),
    ]
    const [headers, ...rows] = sections
    downloadCsv(`${report.project.name}-周报-${report.from}-${report.to}.csv`, (headers as string[]), rows)
    Message.success('周报已导出')
  }

  if (loading && !report) return <LoadingState title="正在加载项目周报" description="正在汇总所选周期内的真实项目数据。" />
  if (error && !report) return <ErrorState description={error} onRetry={load} />
  if (!report) return null
  const completed = report.completedItems || []
  const planned = report.plannedItems || []
  const risks = report.risks || []
  const coordination = report.coordinationItems || []
  return <div className="weekly-report-page">
    <header className="weekly-report-page__heading">
      <div><Typography.Title heading={3}>项目周报</Typography.Title><Typography.Paragraph type="secondary">查看指定周期内的项目进展、完成事项、下周计划与风险。</Typography.Paragraph></div>
      <Space><Button icon={<IconLeft />} onClick={() => navigate(`/projects/${projectId}`)}>返回项目详情</Button><Button icon={<IconDownload />} onClick={exportCsv}>导出 CSV</Button><Button icon={<IconRefresh />} loading={loading} onClick={load}>刷新</Button></Space>
    </header>
    <Card className="weekly-report-page__filters"><Space wrap><Typography.Text bold>报告周期</Typography.Text><Input type="date" value={from} onChange={setFrom} style={{ width: 170 }} /><Typography.Text type="secondary">至</Typography.Text><Input type="date" value={to} onChange={setTo} style={{ width: 170 }} /><Button type="primary" onClick={load}>生成周报</Button>{error ? <Typography.Text type="error">{error}</Typography.Text> : null}</Space></Card>
    <Card className="weekly-report-page__intro"><Space direction="vertical" size={4}><Space><Typography.Text type="secondary">{report.project.code}</Typography.Text><Typography.Title heading={4}>{report.project.name}</Typography.Title></Space><Typography.Text type="secondary">报告周期：{report.from} 至 {report.to} · 生成于 {new Date(report.generatedAt).toLocaleString('zh-CN', { hour12: false })}</Typography.Text>{report.summary ? <Typography.Paragraph>{report.summary}</Typography.Paragraph> : null}</Space></Card>
    <Row gutter={16} className="weekly-report-page__stats"><Col span={6}><Card><Typography.Text type="secondary">本周完成</Typography.Text><Typography.Title heading={3}>{completed.length}</Typography.Title></Card></Col><Col span={6}><Card><Typography.Text type="secondary">下周计划</Typography.Text><Typography.Title heading={3}>{planned.length}</Typography.Title></Card></Col><Col span={6}><Card><Typography.Text type="secondary">风险与问题</Typography.Text><Typography.Title heading={3}>{risks.length}</Typography.Title></Card></Col><Col span={6}><Card><Typography.Text type="secondary">协调事项</Typography.Text><Typography.Title heading={3}>{coordination.length}</Typography.Title></Card></Col></Row>
    <ReportSection title="本周完成事项" items={completed} empty="本周期暂无已完成事项" />
    <ReportSection title="下周计划事项" items={planned} empty="本周期暂无下周计划事项" />
    <RiskSection items={risks} />
    <ReportSection title="协调事项" items={coordination} empty="本周期暂无协调事项" />
  </div>
}

function ReportSection({ title, items, empty }: { title: string; items: WeeklyReportItem[]; empty: string }) {
  return <Card title={title}>{items.length ? <Table rowKey="id" data={items} pagination={false} columns={[{ title: '事项', dataIndex: 'title', render: (_: unknown, item: WeeklyReportItem) => <div><Typography.Text bold>{item.title}</Typography.Text>{item.description ? <Typography.Text type="secondary" className="weekly-report-cell-sub">{item.description}</Typography.Text> : null}</div> }, { title: '负责人', dataIndex: 'ownerName', width: 130, render: value => value || '—' }, { title: '状态', dataIndex: 'status', width: 120, render: value => <Tag>{value}</Tag> }, { title: '进度', dataIndex: 'progress', width: 90, render: value => value == null ? '—' : `${value}%` }, { title: '计划日期', dataIndex: 'plannedDate', width: 125, render: value => formatDate(value) }, { title: '实际日期', dataIndex: 'actualDate', width: 125, render: value => formatDate(value) }]} /> : <Empty description={empty} />}</Card>
}
function RiskSection({ items }: { items: WeeklyReportRisk[] }) {
  return <Card title="风险与问题">{items.length ? <Table rowKey="id" data={items} pagination={false} columns={[{ title: '风险/问题', dataIndex: 'title', render: (_: unknown, item: WeeklyReportRisk) => <div><Typography.Text bold>{item.title}</Typography.Text>{item.description ? <Typography.Text type="secondary" className="weekly-report-cell-sub">{item.description}</Typography.Text> : null}</div> }, { title: '等级', dataIndex: 'level', width: 110, render: value => <Tag color={value === 'critical' || value === 'high' ? 'red' : 'orange'}>{value}</Tag> }, { title: '状态', dataIndex: 'status', width: 120, render: value => <Tag>{value}</Tag> }, { title: '负责人', dataIndex: 'ownerName', width: 130, render: value => value || '—' }, { title: '应对措施', dataIndex: 'mitigation', render: value => value || '—' }]} /> : <Empty description="本周期暂无风险与问题" />}</Card>
}

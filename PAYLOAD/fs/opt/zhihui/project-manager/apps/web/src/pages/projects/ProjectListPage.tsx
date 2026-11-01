import { Button, Card, Form, Input, InputNumber, Message, Modal, Select, Space, Typography } from '@arco-design/web-react'
import { IconApps, IconRight, IconSearch } from '@arco-design/web-react/icon'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { listProjects, createProject, updateProject, archiveProject, restoreProject, type PortfolioProject, type ProjectInput, type ProjectUpdateInput } from '../../api/projects.ts'
import { EmptyState, ErrorState, LoadingState } from '../../components/feedback/index.ts'
import { ProgressBar, StatusTag } from '../../components/ui/index.ts'
import { ApiError } from '../../lib/api-client.ts'

const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '规划中', value: 'planning' },
  { label: '建设中', value: 'in_progress' },
  { label: '已暂停', value: 'on_hold' },
  { label: '已完成', value: 'completed' },
  { label: '已归档', value: 'archived' },
]
const healthOptions = [
  { label: '全部健康度', value: 'all' },
  { label: '健康', value: 'healthy' },
  { label: '需关注', value: 'attention' },
  { label: '高风险', value: 'risk' },
]

export function ProjectListPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [projects, setProjects] = useState<PortfolioProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [modalProject, setModalProject] = useState<PortfolioProject | 'new' | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [actionId, setActionId] = useState<string>()
  const query = params.get('q') ?? ''
  const [queryInput, setQueryInput] = useState(query)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const statusParam = params.get('status') ?? 'all'
  const healthParam = params.get('health') ?? 'all'
  const status = statusOptions.some(item => item.value === statusParam) ? statusParam : 'all'
  const health = healthOptions.some(item => item.value === healthParam) ? healthParam : 'all'

  const load = useCallback(async () => {
    setLoading(true); setError(undefined)
    try { setProjects(await listProjects(showArchived || status === 'archived')) }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : '项目列表加载失败') }
    finally { setLoading(false) }
  }, [showArchived, status])
  useEffect(() => { void load() }, [load])

  const filteredProjects = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return projects.filter(project => {
      const matchesKeyword = !keyword || [project.code, project.name, project.clientName ?? ''].some(value => value.toLowerCase().includes(keyword))
      return matchesKeyword && (status === 'all' || project.status === status) && (health === 'all' || project.effectiveHealth === health)
    })
  }, [health, projects, query, status])

  const updateParam = (key: string, value: string, replace = false) => {
    const next = new URLSearchParams(params)
    if (!value || value === 'all') next.delete(key); else next.set(key, value)
    setParams(next, { replace })
  }
  const updateQuery = (value: string) => {
    setQueryInput(value)
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => updateParam('q', value, true), 250)
  }
  useEffect(() => { setQueryInput(query) }, [query])
  useEffect(() => () => clearTimeout(searchTimer.current), [])

  if (loading) return <LoadingState title="正在加载项目列表" description="正在获取所有未归档项目及其自动健康度。" />
  if (error) return <ErrorState description={error} onRetry={load} />

  return (
    <div className="project-list-page">
      <header className="project-list-page__heading">
        <div><Typography.Title heading={3}>项目列表</Typography.Title><Typography.Paragraph type="secondary">浏览和定位在管项目，已归档项目默认隐藏。</Typography.Paragraph></div>
        <Space><Button onClick={() => navigate('/imports')}>导入计划表</Button><Typography.Text type="secondary">共 {filteredProjects.length} 个项目</Typography.Text></Space>
      </header>
      <Card className="project-list-page__filters">
        <Space size={12} wrap><Button type="primary" icon={<IconApps />} onClick={() => setModalProject('new')}>新增项目</Button><Button onClick={() => setShowArchived(value => !value)}>{showArchived ? '隐藏归档项目' : '查看归档项目'}</Button>
          <Input prefix={<IconSearch />} allowClear placeholder="搜索项目编号、名称或客户单位" value={queryInput} onChange={updateQuery} style={{ width: 340 }} />
          <Select options={statusOptions} value={statusOptions.some(item => item.value === status) ? status : 'all'} onChange={value => updateParam('status', value)} style={{ width: 150 }} />
          <Select options={healthOptions} value={healthOptions.some(item => item.value === health) ? health : 'all'} onChange={value => updateParam('health', value)} style={{ width: 150 }} />
          {(query || status !== 'all' || health !== 'all') ? <Button type="text" onClick={() => { setQueryInput(''); setParams({}) }}>清空筛选</Button> : null}
        </Space>
      </Card>
      {filteredProjects.length === 0 ? <EmptyState title="暂无项目" description="可导入项目计划实施表，系统将按表内项目名称创建项目。" actionLabel="导入计划表" onAction={() => navigate('/imports')} /> : (
        <div className="project-list-grid">{filteredProjects.map(project => <ProjectCard key={project.id} project={project} onOpen={() => navigate(`/projects/${project.id}/tasks`)} onEdit={() => setModalProject(project)} onArchive={async () => { setActionId(project.id); try { await archiveProject(project.id); Message.success('项目已归档'); await load() } catch (reason) { Message.error(reason instanceof ApiError ? reason.message : '归档项目失败') } finally { setActionId(undefined) } }} onRestore={async () => { setActionId(project.id); try { await restoreProject(project.id); Message.success('项目已恢复'); await load() } catch (reason) { Message.error(reason instanceof ApiError ? reason.message : '恢复项目失败') } finally { setActionId(undefined) } }} actionId={actionId} />)}</div>
      )}
      <ProjectFormModal project={modalProject} onClose={() => setModalProject(null)} onSaved={async () => { setModalProject(null); await load() }} />
    </div>
  )
}

function ProjectCard({ project, onOpen, onEdit, onArchive, onRestore, actionId }: { project: PortfolioProject; onOpen: () => void; onEdit: () => void; onArchive: () => void; onRestore: () => void; actionId?: string }) {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
  }
  return <Card className={`project-card project-card--${project.effectiveHealth}`} hoverable role="link" tabIndex={0} onKeyDown={handleKeyDown} onClick={onOpen}>
    <div className="project-card__header"><Space size={8}><Typography.Text type="secondary">{project.code}</Typography.Text><StatusTag value={project.status} /><StatusTag value={project.effectiveHealth} /></Space><IconRight /></div>
    <Typography.Title heading={5}>{project.name}</Typography.Title>
    <Typography.Text type="secondary">{project.category ?? '未分类'}{project.clientName ? ` · ${project.clientName}` : ''}</Typography.Text>
    <ProgressBar value={project.progress} label="总体进度" />
    <div className="project-card__metrics"><span>活动风险 <b>{project.activeRiskCount}</b></span><span>待协调 <b>{project.pendingCoordinationCount}</b></span><span>7天里程碑 <b>{project.upcomingMilestoneCount}</b></span></div>
    <Typography.Text type="secondary" ellipsis>{project.healthReasons[0]?.label ?? '当前未触发自动预警规则'}</Typography.Text>
    <div onClick={(event: React.MouseEvent<HTMLDivElement>) => event.stopPropagation()} style={{ marginTop: 12 }}><Space><Button size="mini" onClick={onEdit}>编辑</Button>{project.status === 'archived' ? <Button size="mini" loading={actionId === project.id} onClick={onRestore}>恢复</Button> : <Button size="mini" status="danger" loading={actionId === project.id} onClick={onArchive}>归档</Button>}</Space></div>
  </Card>
}

function ProjectFormModal({ project, onClose, onSaved }: { project: PortfolioProject | 'new' | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form] = Form.useForm(); const [saving, setSaving] = useState(false); const isNew = project === 'new'
  useEffect(() => { if (!project) return; form.resetFields(); if (!isNew) form.setFieldsValue(project) }, [form, isNew, project])
  if (!project) return null
  const submit = async () => { try { const values = await form.validate(); setSaving(true); if (isNew) await createProject(values as ProjectInput); else await updateProject(project.id, values as ProjectUpdateInput); Message.success(isNew ? '项目已创建' : '项目已更新'); await onSaved() } catch (reason) { if (!(reason instanceof Error && reason.message.includes('required'))) Message.error(reason instanceof ApiError ? reason.message : '保存项目失败') } finally { setSaving(false) } }
  return <Modal title={isNew ? '新增项目' : '编辑项目'} visible onCancel={onClose} onOk={submit} confirmLoading={saving} autoFocus={false}><Form form={form} layout="vertical"><Form.Item field="code" label="项目编号" rules={[{ required: true, message: '请输入项目编号' }]}><Input disabled={!isNew} /></Form.Item><Form.Item field="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}><Input /></Form.Item><Form.Item field="shortName" label="项目简称"><Input /></Form.Item><Form.Item field="category" label="项目分类"><Input /></Form.Item><Form.Item field="clientName" label="客户单位"><Input /></Form.Item><Form.Item field="status" label="状态" initialValue="planning"><Select options={statusOptions.filter(option => option.value !== 'all')} /></Form.Item><Form.Item field="progress" label="进度"><InputNumber min={0} max={100} /></Form.Item><Form.Item field="startDate" label="开始日期"><Input placeholder="YYYY-MM-DD" /></Form.Item><Form.Item field="plannedEndDate" label="计划结束日期"><Input placeholder="YYYY-MM-DD" /></Form.Item><Form.Item field="description" label="项目描述"><Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} /></Form.Item></Form></Modal>
}

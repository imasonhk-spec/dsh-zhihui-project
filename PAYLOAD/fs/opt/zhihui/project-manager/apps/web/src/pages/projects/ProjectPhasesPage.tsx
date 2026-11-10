import { Button, Card, Form, Input, InputNumber, Message, Modal, Progress, Select, Space, Table, Tag, Typography } from '@arco-design/web-react'
import { IconArrowDown, IconArrowUp, IconDelete, IconEdit, IconPlus, IconRefresh } from '@arco-design/web-react/icon'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { createProjectPhase, deleteProjectPhase, listProjectPhases, reorderProjectPhases, updateProjectPhase, type ProjectPhase, type ProjectPhaseInput, type PhaseStatus } from '../../api/projects.ts'
import { ErrorState, LoadingState } from '../../components/feedback/index.ts'
import { ApiError } from '../../lib/api-client.ts'
import { StatusTag } from '../../components/ui/index.ts'

const statusOptions: Array<{ label: string; value: PhaseStatus }> = [
  { label: '未开始', value: 'not_started' },
  { label: '待启动', value: 'ready' },
  { label: '进行中', value: 'in_progress' },
  { label: '已延期', value: 'delayed' },
  { label: '已完成', value: 'completed' },
  { label: '已关闭', value: 'closed' },
  { label: '已取消', value: 'cancelled' },
  { label: '阻塞', value: 'blocked' },
]

export function ProjectPhasesPage() {
  const { projectId = '' } = useParams<{ projectId: string }>()
  const [items, setItems] = useState<ProjectPhase[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<ProjectPhase | 'new' | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(undefined)
    try { setItems((await listProjectPhases(projectId)).slice().sort((a, b) => a.sortOrder - b.sortOrder)) }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : '阶段列表加载失败') }
    finally { setLoading(false) }
  }, [projectId])
  useEffect(() => { void load() }, [load])

  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= items.length || busy) return
    const next = [...items]; [next[index], next[target]] = [next[target], next[index]]
    setBusy(true)
    try { setItems(await reorderProjectPhases(projectId, next.map(item => item.id))); Message.success('阶段顺序已更新') }
    catch (reason) { Message.error(reason instanceof ApiError ? reason.message : '阶段排序失败') }
    finally { setBusy(false) }
  }

  const remove = async (item: ProjectPhase) => {
    Modal.confirm({ title: '删除阶段', content: `确认删除阶段“${item.code} ${item.name}”吗？删除后不可恢复。`, okButtonProps: { status: 'danger' }, onOk: async () => {
      try { setBusy(true); await deleteProjectPhase(projectId, item.id); Message.success('阶段已删除'); await load() }
      catch (reason) {
        if (reason instanceof ApiError && (reason.status === 409 || /phase_has_tasks|关联任务|任务/.test(reason.message))) Message.error('该阶段仍有关联任务，无法删除。请先移除或重新分配任务。')
        else Message.error(reason instanceof ApiError ? reason.message : '删除阶段失败')
      } finally { setBusy(false) }
    } })
  }

  if (loading && !items.length) return <LoadingState title="正在加载项目阶段" description="正在获取当前项目的阶段计划。" />
  if (error && !items.length) return <ErrorState description={error} onRetry={load} />
  const completed = items.filter(item => item.status === 'completed').length
  return <div className="phase-page">
    <header className="phase-page__heading"><div><Typography.Title heading={3}>阶段维护</Typography.Title><Typography.Paragraph type="secondary">维护项目阶段、状态、进度与计划日期，并调整阶段执行顺序。</Typography.Paragraph></div><Space><Button icon={<IconRefresh />} loading={loading} onClick={() => void load()}>刷新</Button><Button type="primary" icon={<IconPlus />} onClick={() => setEditing('new')}>新增阶段</Button></Space></header>
    <Card className="phase-page__summary"><Space size="large"><Typography.Text>阶段总数 <b>{items.length}</b></Typography.Text><Typography.Text>已完成 <b>{completed}</b></Typography.Text><Typography.Text>平均进度 <b>{items.length ? Math.round(items.reduce((sum, item) => sum + item.progress, 0) / items.length) : 0}%</b></Typography.Text></Space></Card>
    <Card title="阶段列表" extra={busy ? <Typography.Text type="secondary">正在保存…</Typography.Text> : null}>
      {error ? <ErrorState title="列表刷新失败" description={error} onRetry={load} /> : items.length ? <Table rowKey="id" data={items} pagination={false} columns={[
        { title: '顺序', width: 90, render: (_, __, index) => <Space size="small"><Typography.Text>{index + 1}</Typography.Text><Space direction="vertical" size={0}><Button type="text" size="mini" icon={<IconArrowUp />} disabled={index === 0 || busy} onClick={() => void move(index, -1)} /><Button type="text" size="mini" icon={<IconArrowDown />} disabled={index === items.length - 1 || busy} onClick={() => void move(index, 1)} /></Space></Space> },
        { title: '阶段', render: (_, item) => <div><Typography.Text bold>{item.code} {item.name}</Typography.Text><Typography.Text type="secondary" className="phase-page__meta">计划 {item.plannedStartDate || '—'} 至 {item.plannedEndDate || '—'}</Typography.Text></div> },
        { title: '状态', dataIndex: 'status', width: 120, render: value => <StatusTag value={value} /> },
        { title: '进度', dataIndex: 'progress', width: 190, render: value => <Space><Progress percent={value} size="small" showText={false} style={{ width: 120 }} /><Typography.Text>{value}%</Typography.Text></Space> },
        { title: '计划开始', dataIndex: 'plannedStartDate', width: 125, render: value => value || '—' },
        { title: '计划结束', dataIndex: 'plannedEndDate', width: 125, render: value => value || '—' },
        { title: '操作', width: 150, render: (_, item) => <Space><Button type="text" icon={<IconEdit />} onClick={() => setEditing(item)}>编辑</Button><Button type="text" status="danger" icon={<IconDelete />} disabled={busy} onClick={() => void remove(item)}>删除</Button></Space> },
      ]} /> : <div className="phase-page__empty">暂无阶段，点击“新增阶段”开始维护。</div>}
    </Card>
    <PhaseForm projectId={projectId} value={editing} busy={busy} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load() }} />
  </div>
}

function PhaseForm({ projectId, value, busy, onClose, onSaved }: { projectId: string; value: ProjectPhase | 'new' | null; busy: boolean; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm(); const [saving, setSaving] = useState(false); const isNew = value === 'new'
  useEffect(() => { if (!value) return; form.resetFields(); if (!isNew) form.setFieldsValue(value) }, [form, isNew, value])
  if (!value) return null
  const submit = async () => { try { const fields = await form.validate(); setSaving(true); if (isNew) await createProjectPhase(projectId, fields as ProjectPhaseInput); else if (!isNew && typeof value !== 'string') await updateProjectPhase(projectId, value.id, fields as Partial<ProjectPhaseInput>); Message.success(isNew ? '阶段已创建' : '阶段已更新'); onSaved() } catch (reason) { if (!(reason instanceof Error && reason.message.includes('required'))) Message.error(reason instanceof ApiError ? reason.message : '保存阶段失败') } finally { setSaving(false) } }
  return <Modal title={isNew ? '新增阶段' : `编辑阶段：${value.code}`} visible onCancel={onClose} onOk={() => void submit()} confirmLoading={saving || busy} autoFocus={false}><Form form={form} layout="vertical"><Form.Item field="code" label="阶段编码" rules={[{ required: true, message: '请输入阶段编码' }]}><Input placeholder="如 P1" /></Form.Item><Form.Item field="name" label="阶段名称" rules={[{ required: true, message: '请输入阶段名称' }]}><Input /></Form.Item><Form.Item field="status" label="状态" initialValue="not_started"><Select options={statusOptions} /></Form.Item><Form.Item field="progress" label="进度"><InputNumber min={0} max={100} precision={0} suffix="%" /></Form.Item><Form.Item field="plannedStartDate" label="计划开始日期"><Input placeholder="YYYY-MM-DD，可留空" /></Form.Item><Form.Item field="plannedEndDate" label="计划结束日期"><Input placeholder="YYYY-MM-DD，可留空" /></Form.Item></Form></Modal>
}

export default ProjectPhasesPage

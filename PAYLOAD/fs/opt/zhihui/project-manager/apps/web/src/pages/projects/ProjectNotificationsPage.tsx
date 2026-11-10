import { Button, Card, Empty, List, Select, Space, Tag, Typography } from '@arco-design/web-react'
import { IconRefresh } from '@arco-design/web-react/icon'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { listProjectNotifications, markProjectNotificationRead, type ProjectNotification } from '../../api/projects.ts'
import { ErrorState, LoadingState } from '../../components/feedback/index.ts'
import { ApiError } from '../../lib/api-client.ts'

export function ProjectNotificationsPage() {
  const { projectId = '' } = useParams<{ projectId: string }>()
  const [items, setItems] = useState<ProjectNotification[]>([])
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    if (!projectId) { setError('缺少项目标识，无法加载通知'); setLoading(false); return }
    setLoading(true); setError(undefined)
    try { setItems(await listProjectNotifications(projectId)) }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : '项目通知加载失败') }
    finally { setLoading(false) }
  }, [projectId])
  useEffect(() => { void load() }, [load])
  const visible = useMemo(() => filter === 'unread' ? items.filter(item => !item.read) : items, [filter, items])
  const markRead = async (id: string) => {
    try { await markProjectNotificationRead(projectId, id); setItems(current => current.map(item => item.id === id ? { ...item, read: true } : item)) }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : '标记通知失败') }
  }
  return <div className="project-detail-page">
    <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
      <div><Typography.Title heading={3}>站内通知</Typography.Title><Typography.Paragraph type="secondary">查看项目最近活动，并处理未读通知。</Typography.Paragraph></div>
      <Button icon={<IconRefresh />} loading={loading} onClick={() => void load()}>刷新</Button>
    </header>
    <Card><Space><Select aria-label="通知筛选" value={filter} onChange={value => setFilter(value as 'all' | 'unread')} options={[{ label: '全部通知', value: 'all' }, { label: '仅未读', value: 'unread' }]} style={{ width: 140 }} /><Typography.Text type="secondary">共 {visible.length} 条</Typography.Text></Space></Card>
    <Card title="最近活动" bodyStyle={{ padding: 0 }}>
      {loading ? <LoadingState title="正在加载通知" description="正在获取当前项目的最近活动。" /> : error ? <ErrorState title="通知加载失败" description={error} onRetry={load} /> : visible.length ? <List dataSource={visible} render={(item: ProjectNotification) => <List.Item key={item.id} extra={item.read ? <Tag color="gray">已读</Tag> : <Button type="text" onClick={() => void markRead(item.id)}>标记已读</Button>}><List.Item.Meta title={<Space><Typography.Text bold={!item.read}>{item.title}</Typography.Text>{!item.read && <Tag color="arcoblue">未读</Tag>}</Space>} description={<Space direction="vertical" size={2}><Typography.Text type="secondary">{item.summary || '暂无摘要'}</Typography.Text><Typography.Text type="secondary">{formatDateTime(item.occurredAt)}</Typography.Text></Space>} /></List.Item>} /> : <Empty description={filter === 'unread' ? '暂无未读通知' : '暂无项目通知'} />}
    </Card>
  </div>
}
function formatDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false }) }
export default ProjectNotificationsPage

import { Avatar, Breadcrumb, Button, Input, Message, Select, Skeleton, Tooltip, Typography } from '@arco-design/web-react'
import { IconDown, IconMenuFold, IconMenuUnfold, IconSearch } from '@arco-design/web-react/icon'
import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useProjectContext } from '../../contexts/ProjectContext.tsx'
import { navigationItems, navigationKeyFromPath, projectPath } from './navigation.tsx'

export type AppHeaderProps = { sidebarCollapsed: boolean; onSidebarCollapsedChange: (collapsed: boolean) => void }

export function AppHeader({ sidebarCollapsed, onSidebarCollapsedChange }: AppHeaderProps) {
  const location = useLocation(); const navigate = useNavigate()
  const { projectId, lastProjectId, isProjectRoute, projects, projectsLoading, projectsError, selectProject } = useProjectContext()
  const [globalQuery, setGlobalQuery] = useState('')
  const loading = projectsLoading, error = projectsError
  const activeItem = navigationItems.find(item => item.key === navigationKeyFromPath(location.pathname)); const selectedProjectId = projectId ?? lastProjectId; const currentProject = projects.find(project => project.id === projectId)
  const options = useMemo(() => projects.map(project => ({ label: `${project.code} · ${project.name}`, value: project.id })), [projects])
  const handleProjectChange = (nextProjectId: string) => { if (!isProjectRoute) return navigate(projectPath(nextProjectId)); const suffix = location.pathname.match(/^\/projects\/[^/]+(\/.*)?$/)?.[1] ?? ''; navigate(projectPath(nextProjectId, suffix)) }
  const handleSearch = () => { const query = globalQuery.trim(); if (query) navigate(`/projects?q=${encodeURIComponent(query)}`) }
  return <header className="app-header">
    <Tooltip content={sidebarCollapsed ? '展开菜单' : '折叠菜单'}><Button className="app-header__collapse" type="text" shape="circle" icon={sidebarCollapsed ? <IconMenuUnfold /> : <IconMenuFold />} aria-label={sidebarCollapsed ? '展开菜单' : '折叠菜单'} onClick={() => onSidebarCollapsedChange(!sidebarCollapsed)} /></Tooltip>
    <div className="app-header__project-select"><Typography.Text type="secondary">当前项目</Typography.Text>{loading ? <Skeleton text={{ rows: 1, width: ['100%'] }} animation /> : <Select aria-label="选择当前项目" placeholder="请选择项目" value={selectedProjectId} options={options} allowClear={false} showSearch filterOption={(input, option) => String((option as { props?: { children?: unknown } }).props?.children ?? '').toLowerCase().includes(input.toLowerCase())} onChange={handleProjectChange} error={Boolean(error)} />}{error ? <Typography.Text className="app-header__project-error" type="error">{error}</Typography.Text> : null}</div>
    <Breadcrumb className="app-header__breadcrumb"><Breadcrumb.Item>智汇·项目</Breadcrumb.Item>{currentProject ? <Breadcrumb.Item>{currentProject.name}</Breadcrumb.Item> : null}<Breadcrumb.Item>{activeItem?.label ?? '页面'}</Breadcrumb.Item></Breadcrumb>
    <div className="app-header__spacer" /><Input className="app-header__search" prefix={<IconSearch />} placeholder="搜索项目 / 风险 / 事项" value={globalQuery} onChange={setGlobalQuery} onPressEnter={handleSearch} allowClear /><span className="app-header__divider" /><Button className="app-header__user" type="text" onClick={() => Message.info('个人中心即将开放')}><Avatar size={30} style={{ backgroundColor: '#095aff' }}>P</Avatar><span className="app-header__user-copy"><b>PMO</b><small>项目管理中心</small></span><IconDown /></Button>
  </header>
}

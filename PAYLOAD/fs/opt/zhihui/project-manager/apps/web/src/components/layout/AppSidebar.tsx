import { Menu } from '@arco-design/web-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useProjectContext } from '../../contexts/ProjectContext.tsx'
import { navigationItems, navigationKeyFromPath, projectPath } from './navigation.tsx'

export type AppSidebarProps = {
  collapsed: boolean
}

export function AppSidebar({ collapsed }: AppSidebarProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { projectId, lastProjectId } = useProjectContext()
  const activeKey = navigationKeyFromPath(location.pathname)

  const handleNavigate = (key: string) => {
    const item = navigationItems.find(entry => entry.key === key)
    if (!item) return
    if (item.globalPath) return navigate(item.globalPath)
    const targetProjectId = projectId ?? lastProjectId
    if (targetProjectId && item.projectPath !== undefined) navigate(projectPath(targetProjectId, item.projectPath))
  }

  return (
    <aside className={`app-sidebar${collapsed ? ' app-sidebar--collapsed' : ''}`}>
      <div className="app-sidebar__brand">
        <span className="app-sidebar__brand-icon">项</span>
        {!collapsed ? <span className="app-sidebar__brand-text">智汇·项目</span> : null}
      </div>
      <Menu
        className="app-sidebar__menu"
        selectedKeys={[activeKey]}
        collapse={collapsed}
        onClickMenuItem={handleNavigate}
      >
        {navigationItems.map(item => {
          const disabled = item.projectPath !== undefined && !projectId && !lastProjectId
          return (
            <Menu.Item key={item.key} disabled={disabled}>
              {item.icon}
              <span>{item.label}</span>
            </Menu.Item>
          )
        })}
      </Menu>
      {!collapsed ? <div className="app-sidebar__foot">智汇·项目 · v0.1.0</div> : null}
    </aside>
  )
}

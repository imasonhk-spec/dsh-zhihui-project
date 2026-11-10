import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { AppHeader } from './components/layout/AppHeader.tsx'
import { AppSidebar } from './components/layout/AppSidebar.tsx'
import { PageContainer } from './components/layout/PageContainer.tsx'
import { ProjectProvider } from './contexts/ProjectContext.tsx'

export function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  return (
    <ProjectProvider>
      <div className={`app-shell${sidebarCollapsed ? ' app-shell--sidebar-collapsed' : ''}`}>
        <AppSidebar collapsed={sidebarCollapsed} />
        <div className="app-shell__main">
          <AppHeader sidebarCollapsed={sidebarCollapsed} onSidebarCollapsedChange={setSidebarCollapsed} />
          <PageContainer><Outlet /></PageContainer>
        </div>
      </div>
    </ProjectProvider>
  )
}

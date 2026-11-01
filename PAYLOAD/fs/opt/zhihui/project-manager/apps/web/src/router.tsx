import { createBrowserRouter, Navigate } from 'react-router-dom'
import { App } from './App.tsx'
import { PlaceholderPage } from './pages/PlaceholderPage.tsx'
import { PortfolioOverviewPage } from './pages/portfolio/PortfolioOverviewPage.tsx'
import { ProjectListPage } from './pages/projects/ProjectListPage.tsx'
import { ProjectDetailPage } from './pages/projects/ProjectDetailPage.tsx'
import { ProjectImportsPage } from './pages/projects/ProjectImportsPage.tsx'
import { ProjectTasksPage } from './pages/projects/ProjectTasksPage.tsx'
import { ProjectMilestonesPage } from './pages/projects/ProjectMilestonesPage.tsx'
import { ProjectRisksPage } from './pages/projects/ProjectRisksPage.tsx'
import { ProjectCoordinationPage } from './pages/projects/ProjectCoordinationPage.tsx'
import { ProjectApprovalsPage } from './pages/projects/ProjectApprovalsPage.tsx'
import { ProjectKnowledgePage } from './pages/projects/ProjectKnowledgePage.tsx'
import { ProjectAiAssistantPage } from './pages/projects/ProjectAiAssistantPage.tsx'
import { ProjectWeeklyReportPage } from './pages/projects/ProjectWeeklyReportPage.tsx'
import { ProjectRouteGuard } from './components/routing/ProjectRouteGuard.tsx'
import { MeetingTodosPage } from './pages/MeetingTodosPage.tsx'

const projectPage = (title: string, description: string) => (
  <PlaceholderPage eyebrow="项目工作区" title={title} description={description} />
)

export const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      {
        path: '/',
        element: <PortfolioOverviewPage />,
      },
      {
        path: '/meeting-todos',
        element: <MeetingTodosPage />,
      },
      {
        path: '/projects',
        element: <ProjectListPage />,
      },
      {
        path: '/imports',
        element: <ProjectImportsPage />,
      },
      {
        path: '/projects/:projectId',
        element: <ProjectRouteGuard><ProjectDetailPage /></ProjectRouteGuard>,
      },
      {
        path: '/projects/:projectId/imports',
        element: <ProjectRouteGuard><ProjectImportsPage /></ProjectRouteGuard>,
      },
      {
        path: '/projects/:projectId/tasks',
        element: <ProjectRouteGuard><ProjectTasksPage /></ProjectRouteGuard>,
      },
      {
        path: '/projects/:projectId/milestones',
        element: <ProjectRouteGuard><ProjectMilestonesPage /></ProjectRouteGuard>,
      },
      {
        path: '/projects/:projectId/risks',
        element: <ProjectRouteGuard><ProjectRisksPage /></ProjectRouteGuard>,
      },
      {
        path: '/projects/:projectId/coordination',
        element: <ProjectRouteGuard><ProjectCoordinationPage /></ProjectRouteGuard>,
      },
      {
        path: '/projects/:projectId/approvals',
        element: <ProjectRouteGuard><ProjectApprovalsPage /></ProjectRouteGuard>,
      },
      {
        path: '/projects/:projectId/knowledge',
        element: <ProjectRouteGuard><ProjectKnowledgePage /></ProjectRouteGuard>,
      },
      {
        path: '/projects/:projectId/ai',
        element: <ProjectRouteGuard><ProjectAiAssistantPage /></ProjectRouteGuard>,
      },
      {
        path: '/projects/:projectId/reports/weekly',
        element: <ProjectRouteGuard><ProjectWeeklyReportPage /></ProjectRouteGuard>,
      },
      {
        path: '/404',
        element: <PlaceholderPage eyebrow="404" title="页面不存在" description="请检查访问地址，或返回项目总览。" />,
      },
      { path: '*', element: <Navigate to="/404" replace /> },
    ],
  },
], { basename: import.meta.env.BASE_URL || '/' })

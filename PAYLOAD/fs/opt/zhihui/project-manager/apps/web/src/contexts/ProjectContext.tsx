import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react'
import { useParams } from 'react-router-dom'
import { listProjects, prefetchGlobalModules, prefetchProjectModules, type PortfolioProject } from '../api/projects.ts'
import { ApiError } from '../lib/api-client.ts'

const LAST_PROJECT_KEY = 'project-manager:last-project-id'

type ProjectContextValue = {
  projectId?: string
  lastProjectId?: string
  isProjectRoute: boolean
  projects: PortfolioProject[]
  projectsLoading: boolean
  projectsError?: string
  clearLastProject: () => void
  selectProject: (projectId: string) => void
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export function ProjectProvider({ children }: PropsWithChildren) {
  const { projectId } = useParams<{ projectId: string }>()
  const [lastProjectId, setLastProjectId] = useState(readLastProjectId)
  const [projects, setProjects] = useState<PortfolioProject[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string>()
  const clearLastProject = useCallback(() => { window.localStorage.removeItem(LAST_PROJECT_KEY); setLastProjectId(undefined) }, [])
  const selectProject = useCallback((nextProjectId: string) => { window.localStorage.setItem(LAST_PROJECT_KEY, nextProjectId); setLastProjectId(nextProjectId) }, [])

  useEffect(() => {
    if (projectId) { window.localStorage.setItem(LAST_PROJECT_KEY, projectId); setLastProjectId(projectId) }
  }, [projectId])
  useEffect(() => {
    let alive = true
    listProjects().then(items => { if (!alive) return; setProjects(items); const remembered = readLastProjectId(); if (!items.length) clearLastProject(); else if (!remembered || !items.some(item => item.id === remembered)) selectProject(items[0]!.id) }).catch(reason => { if (alive) setProjectsError(reason instanceof ApiError ? reason.message : '项目列表加载失败') }).finally(() => { if (alive) setProjectsLoading(false) })
    return () => { alive = false }
  }, [clearLastProject, selectProject])
  useEffect(() => {
    if (!projectsLoading && projects.length) prefetchGlobalModules(projects.map(project => project.id))
  }, [projects, projectsLoading])
  useEffect(() => {
    const target = projectId ?? lastProjectId
    if (!target || projectsLoading || !projects.some(project => project.id === target)) return
    const schedule = window.requestIdleCallback ?? ((callback:IdleRequestCallback) => window.setTimeout(() => callback({ didTimeout:false, timeRemaining:() => 0 } as IdleDeadline), 200))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const handle = schedule(() => prefetchProjectModules(target))
    return () => cancel(handle)
  }, [lastProjectId, projectId, projects, projectsLoading])

  const value = useMemo<ProjectContextValue>(() => ({
    projectId,
    lastProjectId: projectId ?? lastProjectId,
    isProjectRoute: Boolean(projectId),
    projects,
    projectsLoading,
    projectsError,
    clearLastProject,
    selectProject,
  }), [clearLastProject, lastProjectId, projectId, projects, projectsError, projectsLoading, selectProject])

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProjectContext() {
  const context = useContext(ProjectContext)
  if (!context) throw new Error('useProjectContext must be used inside ProjectProvider')
  return context
}

function readLastProjectId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return window.localStorage.getItem(LAST_PROJECT_KEY) ?? undefined
}

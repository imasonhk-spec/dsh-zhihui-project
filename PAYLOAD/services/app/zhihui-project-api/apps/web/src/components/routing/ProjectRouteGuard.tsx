import { useEffect, type PropsWithChildren } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useProjectContext } from '../../contexts/ProjectContext.tsx'
import { ErrorState, LoadingState } from '../feedback/index.ts'

export function ProjectRouteGuard({ children }: PropsWithChildren) {
  const { projectId = '' } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { projects, projectsLoading, projectsError, clearLastProject } = useProjectContext()
  const valid = Boolean(projectId && projects.some(project => project.id === projectId))

  useEffect(() => {
    if (projectsLoading || projectsError || valid) return
    clearLastProject()
    navigate('/projects', { replace: true })
  }, [clearLastProject, navigate, projectsError, projectsLoading, valid])

  if (projectsError) return <ErrorState title="项目加载失败" description={projectsError} />
  if (projectsLoading) return <LoadingState title="正在加载项目" description="首次进入时正在初始化项目工作区。" />
  return valid ? children : null
}

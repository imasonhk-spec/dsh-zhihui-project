import {
  IconApps,
  IconBook,
  IconCalendar,
  IconCheckCircle,
  IconCheckSquare,
  IconDashboard,
  IconExclamationCircle,
  IconNotification,
  IconRobot,
  IconSchedule,
  IconShake,
} from '@arco-design/web-react/icon'
import type { ReactNode } from 'react'

export type NavigationItem = {
  key: string
  label: string
  icon: ReactNode
  projectPath?: string
  globalPath?: string
}

export const navigationItems: NavigationItem[] = [
  { key: 'overview', label: '项目总览', icon: <IconDashboard />, globalPath: '/' },
  { key: 'meeting-todos', label: '周会待办', icon: <IconCheckSquare />, globalPath: '/meeting-todos' },
  { key: 'approvals', label: '项目立项报批', icon: <IconSchedule />, projectPath: '/approvals' },
  { key: 'imports', label: '导入任务', icon: <IconSchedule />, projectPath: '/imports' },
  { key: 'tasks', label: '项目详细任务', icon: <IconCheckCircle />, projectPath: '/tasks' },
  { key: 'milestones', label: '里程碑达成', icon: <IconCalendar />, projectPath: '/milestones' },
  { key: 'risks', label: '项目风险', icon: <IconExclamationCircle />, projectPath: '/risks' },
  { key: 'coordination', label: '需要协调的事项', icon: <IconShake />, projectPath: '/coordination' },
  { key: 'ai', label: '项目智能助手', icon: <IconRobot />, projectPath: '/ai' },
]

export function navigationKeyFromPath(pathname: string): string {
  if (pathname === '/') return 'overview'
  if (pathname === '/projects') return 'projects'
  if (pathname === '/meeting-todos') return 'meeting-todos'
  const modulePath = pathname.match(/^\/projects\/[^/]+(?:\/([^/]+))?/)?.[1]
  return modulePath ?? 'details'
}

export function projectPath(projectId: string, suffix = '') {
  return `/projects/${projectId}${suffix}`
}

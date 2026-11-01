import type { AiScopeMode, ProjectAiScopes } from '../../api/projects.ts'

export type ResolvedAiScope = {
  mode: AiScopeMode
  requestProjectId: string
  currentProjectId: string
  portfolioProjectId: string | null
}

export function portfolioProjectIdOf(scopes: ProjectAiScopes): string | null {
  return scopes.portfolioProjectId
}

export function resolveAiScope(scopes: ProjectAiScopes, mode: AiScopeMode): ResolvedAiScope {
  const currentProjectId = scopes.current.projectId
  const portfolioProjectId = portfolioProjectIdOf(scopes)
  if (mode === 'portfolio') {
    if (!portfolioProjectId) throw new Error('当前账号未提供跨项目汇总范围')
    return { mode, requestProjectId: portfolioProjectId, currentProjectId, portfolioProjectId }
  }
  return { mode, requestProjectId: currentProjectId, currentProjectId, portfolioProjectId }
}

export function initialAiScopeMode(scopes: ProjectAiScopes): AiScopeMode {
  return scopes.defaultScope === 'portfolio' && portfolioProjectIdOf(scopes) ? 'portfolio' : 'current'
}

export function citationProjectId(sourceProjectId: string | null | undefined, targetProjectId: string): string {
  return sourceProjectId || targetProjectId
}

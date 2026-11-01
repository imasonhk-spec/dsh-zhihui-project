import { eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { projects } from '../../db/schema.ts'
import { authorizePortfolioKnowledge, PORTFOLIO_PROJECT_CODE } from '../knowledge/knowledge-authorization.ts'

export type AiScopeOption = { projectId: string; code: string; name: string }
export type AiScopes = {
  current: AiScopeOption
  portfolio: (AiScopeOption & { authorizedProjectCount: number }) | null
  portfolioProjectId: string | null
  defaultScope: 'current' | 'portfolio'
}

type AiScopeDependencies = {
  findProject(projectId: string): Promise<AiScopeOption | undefined>
  findPortfolio(): Promise<AiScopeOption | undefined>
  authorize(projectId: string): Promise<{ authorizedProjectIds: string[] }>
}

const dependencies: AiScopeDependencies = {
  async findProject(projectId) {
    const [row] = await db.select({ projectId: projects.id, code: projects.code, name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1)
    return row
  },
  async findPortfolio() {
    const [row] = await db.select({ projectId: projects.id, code: projects.code, name: projects.name }).from(projects).where(eq(projects.code, PORTFOLIO_PROJECT_CODE)).limit(1)
    return row
  },
  authorize: authorizePortfolioKnowledge,
}

/**
 * Resolves the two UI scopes entirely from server-side project facts.
 * The client never supplies a portfolio id or an authorized project list.
 */
export async function getProjectAiScopes(projectId: string, deps: AiScopeDependencies = dependencies): Promise<AiScopes> {
  const current = await deps.findProject(projectId)
  if (!current) throw new Error('project_not_found')
  const portfolioProject = current.code === PORTFOLIO_PROJECT_CODE ? current : await deps.findPortfolio()
  if (!portfolioProject) return { current, portfolio: null, portfolioProjectId: null, defaultScope: 'current' }
  const authorization = await deps.authorize(portfolioProject.projectId)
  const portfolio = { ...portfolioProject, authorizedProjectCount: authorization.authorizedProjectIds.length }
  return {
    current,
    portfolio,
    portfolioProjectId: portfolio.projectId,
    defaultScope: current.code === PORTFOLIO_PROJECT_CODE ? 'portfolio' : 'current',
  }
}

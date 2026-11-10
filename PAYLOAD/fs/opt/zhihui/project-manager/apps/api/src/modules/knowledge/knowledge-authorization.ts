import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { knowledgeBases, projects } from '../../db/schema.ts'

export const PORTFOLIO_PROJECT_CODE = 'OPP-MASTER'
export const PORTFOLIO_SCOPE = 'authorized-project-set'

export type PortfolioAuthorization = {
  scope: typeof PORTFOLIO_SCOPE
  portfolioProjectId: string
  authorizedProjectIds: string[]
}

type AuthorizationDependencies = {
  projectCode(projectId: string): Promise<string | undefined>
  projectScopeIds(): Promise<string[]>
}

const dependencies: AuthorizationDependencies = {
  async projectCode(projectId) {
    const [project] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId)).limit(1)
    return project?.code
  },
  async projectScopeIds() {
    const rows = await db.select({ projectId: knowledgeBases.projectId }).from(knowledgeBases).where(and(
      eq(knowledgeBases.scope, 'project'),
      isNull(knowledgeBases.accountId),
      isNotNull(knowledgeBases.projectId),
    ))
    return rows.flatMap(row => row.projectId ? [row.projectId] : [])
  },
}

/**
 * Issues the cross-project scope exclusively from server-side project/knowledge-base facts.
 * No client supplied scope or project-id list is accepted by this boundary.
 */
export async function authorizePortfolioKnowledge(
  portfolioProjectId: string,
  deps: AuthorizationDependencies = dependencies,
): Promise<PortfolioAuthorization> {
  const code = await deps.projectCode(portfolioProjectId)
  if (code === undefined) throw new Error('project_not_found')
  if (code !== PORTFOLIO_PROJECT_CODE) throw new Error('knowledge_portfolio_forbidden')
  const authorizedProjectIds = [...new Set(await deps.projectScopeIds())].sort()
  if (!authorizedProjectIds.length) throw new Error('knowledge_portfolio_scope_empty')
  return { scope: PORTFOLIO_SCOPE, portfolioProjectId, authorizedProjectIds }
}

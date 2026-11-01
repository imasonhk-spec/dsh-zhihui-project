import { sql, type SQL } from 'drizzle-orm'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateAuthorizedProjectIds(projectIds: readonly string[]) {
  const normalized = [...new Set(projectIds)]
  if (!normalized.length || normalized.length > 10_000 || normalized.some(id => !UUID_PATTERN.test(id))) {
    throw new Error('knowledge_authorized_projects_invalid')
  }
  return normalized
}

/** Mandatory pre-retrieval boundary shared by semantic and lexical candidate SQL. */
export function authorizedProjectKnowledgePredicate(projectIds: readonly string[]): SQL {
  const normalized = validateAuthorizedProjectIds(projectIds)
  return sql`d.project_id is not null
    and d.project_id in (${sql.join(normalized.map(id => sql`${id}::uuid`), sql`, `)})
    and kb.scope = 'project'
    and kb.account_id is null
    and kb.project_id = d.project_id`
}

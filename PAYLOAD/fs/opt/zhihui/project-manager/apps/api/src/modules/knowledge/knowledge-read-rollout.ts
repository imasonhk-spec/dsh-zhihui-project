export type KnowledgeReadMode = 'legacy' | 'shadow'

export type KnowledgeReadPolicy = {
  mode: KnowledgeReadMode
  candidateReadOnly: true
  productionRolloutPercent: 0
}

export type ShadowComparison = {
  legacyCount: number
  candidateCount: number
  overlapCount: number
  legacyOnlyIds: string[]
  candidateOnlyIds: string[]
  candidateError?: string
}

export type KnowledgeReadResult<T> = {
  value: T
  servedBy: 'legacy'
  policy: KnowledgeReadPolicy
  shadow?: ShadowComparison
}

export function resolveKnowledgeReadPolicy(value = process.env.KNOWLEDGE_READ_MODE): KnowledgeReadPolicy {
  const normalized = value?.trim().toLowerCase()
  return {
    mode: normalized === 'shadow' ? 'shadow' : 'legacy',
    candidateReadOnly: true,
    productionRolloutPercent: 0,
  }
}

export function rollbackKnowledgeReadPolicy(): KnowledgeReadPolicy {
  return resolveKnowledgeReadPolicy('legacy')
}

export async function executeKnowledgeRead<T>(input: {
  policy?: KnowledgeReadPolicy
  legacy: () => Promise<T>
  candidate: () => Promise<T>
  ids: (value: T) => string[]
}): Promise<KnowledgeReadResult<T>> {
  const policy = input.policy ?? resolveKnowledgeReadPolicy()
  const value = await input.legacy()
  if (policy.mode === 'legacy') return { value, servedBy: 'legacy', policy }

  try {
    const candidate = await input.candidate()
    return { value, servedBy: 'legacy', policy, shadow: compareIds(input.ids(value), input.ids(candidate)) }
  } catch (error) {
    return {
      value,
      servedBy: 'legacy',
      policy,
      shadow: {
        ...compareIds(input.ids(value), []),
        candidateError: error instanceof Error ? error.message : 'candidate_read_failed',
      },
    }
  }
}

function compareIds(legacyIds: string[], candidateIds: string[]): ShadowComparison {
  const legacy = new Set(legacyIds)
  const candidate = new Set(candidateIds)
  return {
    legacyCount: legacy.size,
    candidateCount: candidate.size,
    overlapCount: [...legacy].filter(id => candidate.has(id)).length,
    legacyOnlyIds: [...legacy].filter(id => !candidate.has(id)).sort(),
    candidateOnlyIds: [...candidate].filter(id => !legacy.has(id)).sort(),
  }
}

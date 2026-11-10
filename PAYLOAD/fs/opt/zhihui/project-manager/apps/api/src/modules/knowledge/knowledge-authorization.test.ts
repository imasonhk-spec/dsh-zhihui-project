import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizePortfolioKnowledge, PORTFOLIO_SCOPE } from './knowledge-authorization.ts'

const PROJECT_A = '00000000-0000-4000-8000-000000000001'
const PROJECT_B = '00000000-0000-4000-8000-000000000002'
const PORTFOLIO = '00000000-0000-4000-8000-000000000099'

test('ordinary projects cannot mint an all-projects authorization', async () => {
  await assert.rejects(
    authorizePortfolioKnowledge(PROJECT_A, {
      projectCode: async () => 'NORMAL-PROJECT',
      projectScopeIds: async () => [PROJECT_A, PROJECT_B],
    }),
    /knowledge_portfolio_forbidden/,
  )
})

test('unknown projects are rejected before scope resolution', async () => {
  let queried = false
  await assert.rejects(
    authorizePortfolioKnowledge(PROJECT_A, {
      projectCode: async () => undefined,
      projectScopeIds: async () => { queried = true; return [PROJECT_A] },
    }),
    /project_not_found/,
  )
  assert.equal(queried, false)
})

test('portfolio authorization is server issued, unique and deterministic', async () => {
  const authorization = await authorizePortfolioKnowledge(PORTFOLIO, {
    projectCode: async () => 'OPP-MASTER',
    projectScopeIds: async () => [PROJECT_B, PROJECT_A, PROJECT_B],
  })
  assert.deepEqual(authorization, {
    scope: PORTFOLIO_SCOPE,
    portfolioProjectId: PORTFOLIO,
    authorizedProjectIds: [PROJECT_A, PROJECT_B],
  })
})

test('portfolio with no server-authorized project knowledge bases is denied', async () => {
  await assert.rejects(
    authorizePortfolioKnowledge(PORTFOLIO, {
      projectCode: async () => 'OPP-MASTER',
      projectScopeIds: async () => [],
    }),
    /knowledge_portfolio_scope_empty/,
  )
})

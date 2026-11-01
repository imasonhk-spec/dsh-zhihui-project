import { strict as assert } from 'node:assert'
import { citationProjectId,initialAiScopeMode,portfolioProjectIdOf,resolveAiScope } from '../apps/web/src/pages/projects/project-ai-scope.ts'
import type { ProjectAiScopes } from '../apps/web/src/api/projects.ts'

const ordinary:ProjectAiScopes={
  current:{projectId:'current-project',code:'PRJ-001',name:'当前项目'},
  portfolio:{projectId:'portfolio-project',code:'OPP-MASTER',name:'跨项目汇总',authorizedProjectCount:13},
  portfolioProjectId:'portfolio-project',
  defaultScope:'current',
}
assert.equal(initialAiScopeMode(ordinary),'current')
assert.deepEqual(resolveAiScope(ordinary,'current'),{mode:'current',requestProjectId:'current-project',currentProjectId:'current-project',portfolioProjectId:'portfolio-project'})
assert.deepEqual(resolveAiScope(ordinary,'portfolio'),{mode:'portfolio',requestProjectId:'portfolio-project',currentProjectId:'current-project',portfolioProjectId:'portfolio-project'})

const master:ProjectAiScopes={
  ...ordinary,
  current:{projectId:'portfolio-project',code:'OPP-MASTER',name:'跨项目汇总'},
  defaultScope:'portfolio',
}
assert.equal(initialAiScopeMode(master),'portfolio')
assert.equal(resolveAiScope(master,'current').requestProjectId,'portfolio-project')
assert.equal(resolveAiScope(master,'portfolio').requestProjectId,'portfolio-project')

const canonicalTopLevelId:ProjectAiScopes={
  current:{projectId:'current-project',code:'PRJ-001',name:'当前项目'},
  portfolio:{projectId:'portfolio-display-id',code:'OPP-MASTER',name:'跨项目汇总',authorizedProjectCount:8},
  portfolioProjectId:'portfolio-from-server',
  defaultScope:'portfolio',
}
assert.equal(portfolioProjectIdOf(canonicalTopLevelId),'portfolio-from-server')
assert.equal(resolveAiScope(canonicalTopLevelId,'portfolio').requestProjectId,'portfolio-from-server')
assert.equal(citationProjectId('source-project','portfolio-project'),'source-project')
assert.equal(citationProjectId(null,'portfolio-project'),'portfolio-project')

const currentOnly:ProjectAiScopes={
  current:{projectId:'current-project',code:'PRJ-001',name:'当前项目'},
  portfolio:null,
  portfolioProjectId:null,
  defaultScope:'current',
}
assert.equal(initialAiScopeMode(currentOnly),'current')
assert.throws(()=>resolveAiScope(currentOnly,'portfolio'),/未提供跨项目汇总范围/)
console.log('project AI scope contract assertions passed')

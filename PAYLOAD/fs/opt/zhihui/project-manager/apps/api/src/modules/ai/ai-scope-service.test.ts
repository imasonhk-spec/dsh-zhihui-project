import test from 'node:test'
import assert from 'node:assert/strict'
import { getProjectAiScopes } from './ai-scope-service.ts'

const current={projectId:'11111111-1111-4111-8111-111111111111',code:'P-001',name:'项目一'}
const portfolio={projectId:'22222222-2222-4222-8222-222222222222',code:'OPP-MASTER',name:'商机组合'}

test('ordinary project defaults to current and exposes server-resolved portfolio scope',async()=>{
 const result=await getProjectAiScopes(current.projectId,{findProject:async()=>current,findPortfolio:async()=>portfolio,authorize:async id=>{assert.equal(id,portfolio.projectId);return{authorizedProjectIds:['a','b','c']}}})
 assert.deepEqual(result,{current,portfolio:{...portfolio,authorizedProjectCount:3},portfolioProjectId:portfolio.projectId,defaultScope:'current'})
})

test('portfolio project defaults to portfolio without accepting a client supplied project set',async()=>{
 let findPortfolioCalled=false
 const result=await getProjectAiScopes(portfolio.projectId,{findProject:async()=>portfolio,findPortfolio:async()=>{findPortfolioCalled=true;return undefined},authorize:async()=>({authorizedProjectIds:['a']})})
 assert.equal(findPortfolioCalled,false)
 assert.equal(result.defaultScope,'portfolio')
 assert.equal(result.portfolio?.authorizedProjectCount,1)
})

test('missing current project is rejected',async()=>{
 await assert.rejects(()=>getProjectAiScopes('missing',{findProject:async()=>undefined,findPortfolio:async()=>portfolio,authorize:async()=>({authorizedProjectIds:['a']})}),/project_not_found/)
})

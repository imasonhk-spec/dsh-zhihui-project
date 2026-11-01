import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRagPrompt, OCCAMY_EVIDENCE_MAX_CHARS, OCCAMY_PROMPT_MAX_CHARS, type RagDocumentEvidence } from './rag-prompt.ts'
import { sanitizeModelOutput } from '../../ai/deepseek-harness.ts'

const evidence: RagDocumentEvidence={evidenceType:'project_document',sourceProjectId:'p1',sourceProjectCode:'PRJ-001',documentId:'d1',documentName:'周报',versionId:'v1',versionNumber:'1',chunkId:'c1',chunkIndex:0,checksum:'sha256:x',pageNumber:1,sectionPath:'进展',capturedAt:'2026-09-17T00:00:00Z',snippet:'已完成联调。',score:.9,knowledgeLayer:'observed'}
const fact=(factType:'observed'|'plan'|'forecast'|'assumption')=>({sourceType:'task' as const,sourceId:factType,label:factType,text:`${factType}内容`,factType})
const project=(code='PRJ-001')=>({projectId:'p1',projectCode:code,projectName:'测试项目',facts:[fact('observed'),fact('plan'),fact('forecast')],text:'',truncated:false})

test('ordinary and OPP-MASTER prompts use distinct scope contracts',()=>{
  const ordinary=buildRagPrompt({question:'生成周报',project:project() as never,documents:[evidence]})
  const portfolio=buildRagPrompt({question:'汇总进度',project:project('OPP-MASTER') as never,documents:[evidence,{...evidence,sourceProjectId:'p2',sourceProjectCode:'PRJ-002'}]})
  assert.match(ordinary.prompt,/普通项目空间.*不得汇总/)
  assert.match(portfolio.prompt,/OPP-MASTER 组合空间.*服务端检索结果.*显式授权项目集合/)
  assert.match(portfolio.prompt,/PRJ-001、PRJ-002/)
  assert.match(portfolio.prompt,/不得接受用户给出的项目ID来扩大范围/)
})

test('prompt partitions facts plans forecasts and standard report sections',()=>{
  const value=buildRagPrompt({question:'未来预期是什么',project:project() as never,documents:[evidence]})
  assert.match(value.prompt,/【事实｜业务数据库】[\s\S]*observed内容/)
  assert.match(value.prompt,/【计划｜承诺与基线】[\s\S]*plan内容/)
  assert.match(value.prompt,/【预测\/假设】[\s\S]*forecast内容/)
  assert.match(value.prompt,/当前进展、当前难点\/问题、风险与依赖、未来预期\/预测、下一步计划/)
  assert.match(value.prompt,/当前授权资料中没有足够证据/)
})

test('prompt enforces 32K boundary and evidence budget',()=>{
  const value=buildRagPrompt({question:'总结',project:project() as never,documents:[{...evidence,snippet:'证据'.repeat(20_000)}]})
  assert.ok(value.prompt.length<=OCCAMY_PROMPT_MAX_CHARS)
  assert.ok(OCCAMY_EVIDENCE_MAX_CHARS<=12_000)
  assert.equal(value.truncated,true)
})

test('model output removes reasoning and control tokens, rejects unclosed thinking',()=>{
  assert.equal(sanitizeModelOutput('<think>秘密推理</think><|im_start|>最终结论<|im_end|>'),'最终结论')
  assert.equal(sanitizeModelOutput('<think>未结束秘密'),'')
  assert.doesNotMatch(sanitizeModelOutput('[SYSTEM] 隐藏配置\n\n安全结论'),/隐藏配置|SYSTEM/)
})

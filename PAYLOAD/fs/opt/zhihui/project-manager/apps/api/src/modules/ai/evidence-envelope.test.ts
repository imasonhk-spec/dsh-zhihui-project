import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRagPrompt, type RagDocumentEvidence } from './rag-prompt.ts'
import { selectCitedEvidence } from './rag-answer-service.ts'

const evidence: RagDocumentEvidence[] = [{
  evidenceType: 'project_document', sourceProjectId: '11111111-1111-4111-8111-111111111111', sourceProjectCode: 'PRJ-001',
  documentId: '22222222-2222-4222-8222-222222222222', documentName: '验收报告', versionId: '33333333-3333-4333-8333-333333333333',
  versionNumber: 'v2.1', chunkId: '44444444-4444-4444-8444-444444444444', chunkIndex: 7, checksum: 'sha256:abc', pageNumber: 3,
  sectionPath: '结论/验收', capturedAt: '2026-09-17T00:00:00.000Z', snippet: '项目已通过验收。', score: 0.91,
}]

const project = { projectId: evidence[0]!.sourceProjectId, projectCode: 'PRJ-001', projectName: '测试项目', text: '', truncated: false } as never

test('prompt exposes only the stable minimum citation header', () => {
  const result = buildRagPrompt({ question: '是否验收？', project, documents: evidence })
  assert.match(result.prompt, /\[知识文档:1\] 层级=observed；来源项目=PRJ-001；文档=验收报告；版本=v2\.1；分块=7；校验和=sha256:abc；页码=3；章节=结论\/验收；相关度=0\.9100/)
  const evidenceSection=result.prompt.split('【项目文档证据】')[1]!.split('【模板证据')[0]!
  assert.doesNotMatch(evidenceSection, /sourceProjectId|versionId|chunkId|capturedAt|11111111-1111|33333333-3333|44444444-4444/)
})

test('citation number maps to the complete EvidenceEnvelope without exposing it in prompt', () => {
  const selected = selectCitedEvidence('结论【文档:1】重复【文档:1】', evidence)
  assert.equal(selected.length, 1)
  assert.deepEqual(selected[0], evidence[0])
  assert.equal(selected[0]?.sourceProjectId,'11111111-1111-4111-8111-111111111111')
  assert.equal(selected[0]?.versionId,'33333333-3333-4333-8333-333333333333')
  assert.equal(selected[0]?.chunkId,'44444444-4444-4444-8444-444444444444')
  assert.equal(selected[0]?.capturedAt,'2026-09-17T00:00:00.000Z')
})

test('24K total and 12K evidence budgets are the hard defaults',()=>{
  const result=buildRagPrompt({question:'问题'.repeat(4_000),project,documents:[{...evidence[0]!,snippet:'证据'.repeat(20_000)}]})
  assert.ok(result.prompt.length<=24_000)
  assert.equal(result.truncated,true)
})

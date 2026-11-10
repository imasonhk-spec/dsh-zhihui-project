import assert from 'node:assert/strict'
import { mapProjectAdapterFields, projectAdapterContract } from './project-adapter.ts'

assert.equal(projectAdapterContract.mode, 'read-only')
assert.equal(projectAdapterContract.productionGateway, false)
const mapped = mapProjectAdapterFields({ project: { id: 'p1', code: 'P-1', name: '示例', progress: 20 }, workspace: { knowledgeBaseId: 'kb1', folders: [{ id: 'f1', path: '交付', parentId: undefined }] }, ai: { conversationId: 'c1', content: '答复', citations: ['d1'] } })
assert.deepEqual(mapped.workspace?.folders[0], { id: 'f1', path: '交付', parentId: null })
assert.deepEqual(mapped.ai?.citations, ['d1'])
console.log(JSON.stringify({ ok: true, contract: projectAdapterContract.version, acl: projectAdapterContract.acl }))

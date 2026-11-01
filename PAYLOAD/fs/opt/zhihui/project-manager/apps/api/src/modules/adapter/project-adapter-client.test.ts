import assert from 'node:assert/strict'
import { createProjectAdapterClient, ProjectAdapterError } from './project-adapter-client.ts'
const calls: any[] = []
const fetcher = async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }) }
const client = createProjectAdapterClient({ baseUrl: 'http://upstream/', serviceToken: 'secret', fetcher })
await client.searchKnowledge('p-1', '风险')
assert.equal(calls[0].init.headers?.['x-zh-service'], 'secret'); assert.equal(client.contract.productionGateway, false); assert.equal(calls[0].init.headers?.authorization, undefined); assert.equal(calls[0].url, 'http://upstream/api/projects/p-1/knowledge/search?q=%E9%A3%8E%E9%99%A9')
await assert.rejects(async () => client.listConversations('bad id'), (e: ProjectAdapterError) => e.code === 'adapter_parameters_invalid')
await assert.rejects(async () => createProjectAdapterClient({ baseUrl: '', serviceToken: 'x' }), (e: ProjectAdapterError) => e.code === 'adapter_configuration_invalid')
console.log(JSON.stringify({ ok: true, security: 'service-token/project-validation' }))

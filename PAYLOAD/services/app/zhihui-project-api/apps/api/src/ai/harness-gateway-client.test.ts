import assert from 'node:assert/strict'
import { acceptHarnessGatewaySequence, normalizeHarnessGatewayFrame } from './harness-gateway-client.ts'

const valid = normalizeHarnessGatewayFrame({
  type: 'server-request',
  payload: { sessionId: 's-1', type: 'session/event', event: { type: 'assistant/chunk', seq: 4, time: 123, data: { chunk: { type: 'text-delta', text: 'hi' } } }, view: { safe: true } },
})
assert.equal(valid?.sessionId, 's-1')
assert.equal(valid?.event.seq, 4)
assert.equal(valid?.event.data.chunk && typeof valid.event.data.chunk, 'object')
assert.deepEqual(valid?.view, { safe: true })

const subscribed = normalizeHarnessGatewayFrame({ type: 'server-request', payload: { sessionId: 's-1', type: 'session/subscribed', lastSeq: 3 } })
assert.deepEqual(subscribed?.event, { type: 'session/subscribed', seq: 3, data: { lastSeq: 3 } })

assert.equal(normalizeHarnessGatewayFrame({ type: 'server-request', payload: { sessionId: 's-1', type: 'session/event', event: { type: 'x', seq: -1, data: {} } } }), undefined)
assert.equal(normalizeHarnessGatewayFrame({ type: 'server-request', payload: { sessionId: 's-1', type: 'session/event', event: { type: 'x', seq: 1, data: [] } } }), undefined)
assert.equal(normalizeHarnessGatewayFrame({ type: 'other', payload: {} }), undefined)
assert.equal(acceptHarnessGatewaySequence(4, 4), 'duplicate')
assert.equal(acceptHarnessGatewaySequence(4, 5), 'contiguous')
assert.equal(acceptHarnessGatewaySequence(4, 6), 'gap')
console.log(JSON.stringify({ ok: true, scope: 'isolated-harness-gateway-fixture' }))

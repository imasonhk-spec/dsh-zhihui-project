import assert from 'node:assert/strict'
import test from 'node:test'
import { AiStreamService, type AiStreamDependencies, type AiStreamEvent } from './ai-stream-service.ts'
import type { HarnessMuxEvent, HarnessMuxListener } from '../../ai/harness-mux.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function fixture(overrides: Partial<AiStreamDependencies> = {}) {
  let muxListener: HarnessMuxListener | undefined
  let unsubscribeCalls = 0
  let exchangeCalls = 0
  const reports: string[] = []
  const updates: Array<Record<string, unknown>> = []
  const harness = {
    sendPrompt: async () => ({ accepted: true as const }),
    cancel: async () => undefined,
    history: async (_sessionId?: string, _maxMessages?: number, _beforeSeq?: number) => ({ events: [] as Array<{ event?: { type?: string; seq?: number; data?: Record<string, unknown> } }>, hasMore: false }),
  }
  const mux = {
    subscribe: (_sessionId: string, listener: HarnessMuxListener) => {
      muxListener = listener
      return () => { unsubscribeCalls += 1 }
    },
  }
  const deps: AiStreamDependencies = {
    getConversation: async () => ({ id: 'conversation-1', projectId: 'project-1', harnessSessionId: 'session-1', lastEventSeq: 0 } as never),
    getMessage: async () => undefined,
    listMessages: async () => ({ items: [], total: 0, limit: 200, offset: 0 } as never),
    prepareRag: async () => ({ evidence: [], prompt: 'question', retrieval: { mode: 'none' }, degraded: false, truncated: false } as never),
    createExchange: async () => {
      exchangeCalls += 1
      return { duplicate: false, userMessage: { id: `user-${exchangeCalls}` }, assistantMessage: { id: `assistant-${exchangeCalls}` } } as never
    },
    updateMessage: async (_projectId, _conversationId, _messageId, input) => { updates.push(input); return { id: 'assistant-1' } as never },
    finalizeAnswer: async () => ({ id: 'assistant-1', status: 'completed' } as never),
    selectEvidence: () => [],
    reportBackgroundError: code => { reports.push(code) },
    scheduleEmitterCleanup: callback => callback(),
    ...overrides,
  }
  const service = new AiStreamService(harness as never, mux as never, deps)
  const emit = (type: string, seq: number, data: Record<string, unknown> = {}) => {
    assert.ok(muxListener)
    const frame: HarnessMuxEvent = { sessionId: 'session-1', event: { type, seq, data } }
    muxListener(frame)
  }
  return { service, harness, deps, emit, reports, updates, get unsubscribeCalls() { return unsubscribeCalls }, get exchangeCalls() { return exchangeCalls } }
}

async function startAndCollect(f: ReturnType<typeof fixture>) {
  await f.service.start('project-1', 'conversation-1', 'question', 'request-1')
  const events: AiStreamEvent[] = []
  f.service.subscribe('project-1', 'conversation-1', 0, event => events.push(event))
  return events
}

test('mux frames are serialized before updating text and sequence', async () => {
  let releaseFirst!: () => void
  const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve })
  let calls = 0
  const f = fixture({
    updateMessage: async (_projectId, _conversationId, _messageId, input) => {
      calls += 1
      f.updates.push(input)
      if (calls === 1) await firstWrite
      return { id: 'assistant-1' } as never
    },
  })
  const events = await startAndCollect(f)
  f.emit('assistant/chunk', 1, { chunk: { type: 'text-delta', text: 'A' } })
  f.emit('assistant/chunk', 2, { chunk: { type: 'text-delta', text: 'B' } })
  await tick()
  assert.equal(calls, 1)
  releaseFirst()
  await tick(); await tick()
  assert.equal(calls, 2)
  assert.deepEqual(f.updates.map(item => [item.content, item.lastEventSeq]), [['A', 1], ['AB', 2]])
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.data.content), ['A', 'AB'])
})

test('resets a persisted sequence baseline when the Harness session history was rebuilt', async () => {
  const f = fixture({
    getConversation: async () => ({ id: 'conversation-1', projectId: 'project-1', harnessSessionId: 'session-1', lastEventSeq: 728 } as never),
  })
  f.harness.history = async () => ({ hasMore: false, events: [{ event: { type: 'turn/end', seq: 43, data: { turn: 1, reason: { kind: 'completed' } } } }] })
  const events = await startAndCollect(f)
  f.emit('turn/start', 1, { turn: 1 })
  f.emit('assistant/message', 2, { turn: 1, message: { content: [{ type: 'text', text: 'recovered answer' }] } })
  f.emit('turn/end', 3, { turn: 1, reason: { kind: 'completed' } })
  await tick(); await tick(); await tick()
  assert.equal(events.at(-1)?.type, 'completed')
})

test('concurrent starts share one in-flight operation', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = fixture({ prepareRag: async () => { await gate; return { evidence: [], prompt: 'question', retrieval: { mode: 'none' }, degraded: false, truncated: false } as never } })
  const first = f.service.start('project-1', 'conversation-1', 'one', 'request-1')
  const second = f.service.start('project-1', 'conversation-1', 'two', 'request-2')
  await tick()
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(f.exchangeCalls, 1)
  assert.strictEqual(a, b)
})

test('gap recovery calls history once and applies recovered frames in order', async () => {
  const f = fixture()
  let historyCalls = 0
  f.harness.history = async () => {
    historyCalls += 1
    return { hasMore: false, events: [
      { event: { type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'text-delta', text: 'A' } } } },
      { event: { type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', text: 'B' } } } },
    ] }
  }
  await startAndCollect(f)
  f.emit('assistant/chunk', 3, { chunk: { type: 'text-delta', text: 'C' } })
  await tick(); await tick(); await tick()
  assert.equal(historyCalls, 1)
  assert.deepEqual(f.updates.map(item => [item.content, item.lastEventSeq]), [['A', 1], ['AB', 2], ['ABC', 3]])
})

test('recovery ignores prior-turn tail until the new exchange turn starts', async () => {
  const f = fixture({
    getConversation: async () => ({ id: 'conversation-1', projectId: 'project-1', harnessSessionId: 'session-1', lastEventSeq: 10 } as never),
  })
  f.harness.history = async () => ({ hasMore: false, events: [
    { event: { type: 'assistant/chunk', seq: 11, data: { chunk: { type: 'text-delta', text: 'OLD' } } } },
    { event: { type: 'turn/end', seq: 12, data: { turn: 1, reason: { kind: 'completed' } } } },
    { event: { type: 'turn/start', seq: 13, data: { turn: 2 } } },
    { event: { type: 'assistant/chunk', seq: 14, data: { chunk: { type: 'text-delta', text: 'NEW' } } } },
  ] })
  const events = await startAndCollect(f)
  f.emit('assistant/chunk', 15, { chunk: { type: 'text-delta', text: '!' } })
  await tick(); await tick(); await tick()
  assert.deepEqual(f.updates.map(item => [item.content, item.lastEventSeq]), [['NEW', 14], ['NEW!', 15]])
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.data.content), ['NEW', 'NEW!'])
  assert.equal(events.some(event => event.type === 'completed'), false)
})

test('multi-page gap recovery walks backwards, deduplicates boundaries, and replays ascending', async () => {
  const f = fixture()
  const cursors: Array<number | undefined> = []
  const event = (seq: number, text: string) => ({ event: { type: 'assistant/chunk', seq, data: { chunk: { type: 'text-delta', text } } } })
  f.harness.history = async (_sessionId?: string, _maxMessages?: number, beforeSeq?: number) => {
    cursors.push(beforeSeq)
    if (beforeSeq === undefined) return { hasMore: true, events: [event(3, 'C'), event(4, 'D')] }
    if (beforeSeq === 3) return { hasMore: false, events: [event(1, 'A'), event(2, 'B'), event(3, 'duplicate')] }
    throw new Error(`unexpected-cursor:${beforeSeq}`)
  }
  await startAndCollect(f)
  f.emit('assistant/chunk', 5, { chunk: { type: 'text-delta', text: 'E' } })
  await tick(); await tick(); await tick()
  assert.deepEqual(cursors, [undefined, 3])
  assert.deepEqual(f.updates.map(item => [item.content, item.lastEventSeq]), [['A', 1], ['AB', 2], ['ABC', 3], ['ABCD', 4], ['ABCDE', 5]])
})

test('history pagination without cursor progress is contained as a retryable failure', async () => {
  const f = fixture()
  let calls = 0
  const event = (seq: number) => ({ event: { type: 'assistant/chunk', seq, data: { chunk: { type: 'text-delta', text: 'X' } } } })
  f.harness.history = async () => { calls += 1; return { hasMore: true, events: [event(5)] } }
  const events = await startAndCollect(f)
  f.emit('session/subscribed', 10)
  await tick(); await tick(); await tick()
  assert.equal(calls, 2)
  assert.equal(f.updates.at(-1)?.status, 'failed')
  assert.equal(events.at(-1)?.type, 'error')
  assert.equal(f.reports[0], 'ai_stream_processing_failed')
})

test('history pagination with an empty hasMore page is contained as a retryable failure', async () => {
  const f = fixture()
  f.harness.history = async () => ({ hasMore: true, events: [] })
  const events = await startAndCollect(f)
  f.emit('session/subscribed', 10)
  await tick(); await tick(); await tick()
  assert.equal(f.updates.at(-1)?.status, 'failed')
  assert.equal(events.at(-1)?.type, 'error')
  assert.equal(f.unsubscribeCalls, 1)
})

test('empty completed turn becomes a retryable failed terminal state', async () => {
  const f = fixture()
  const events = await startAndCollect(f)
  f.emit('turn/end', 1, { reason: { kind: 'completed' } })
  await tick(); await tick()
  assert.equal(f.updates.at(-1)?.status, 'failed')
  assert.equal(f.updates.at(-1)?.errorCode, 'harness_empty_answer')
  assert.equal(events.at(-1)?.type, 'error')
  assert.equal(f.unsubscribeCalls, 1)
  assert.equal(await f.service.cancel('project-1', 'conversation-1'), false)
})

test('unknown turn end becomes a controlled failed terminal state', async () => {
  const f = fixture()
  const events = await startAndCollect(f)
  f.emit('turn/end', 1, { reason: { kind: 'provider_failed_with_sensitive_detail' } })
  await tick(); await tick()
  assert.equal(f.updates.at(-1)?.status, 'failed')
  assert.equal(f.updates.at(-1)?.errorCode, 'harness_turn_failed')
  assert.equal(events.at(-1)?.type, 'error')
  assert.equal(f.unsubscribeCalls, 1)
})

test('database rejection is contained, persisted once, and disposes activity', async () => {
  let calls = 0
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const f = fixture({
    updateMessage: async (_projectId, _conversationId, _messageId, input) => {
      calls += 1
      if (calls === 1) throw new Error('db-write-failed')
      f.updates.push(input)
      return { id: 'assistant-1' } as never
    },
  })
  try {
    const events = await startAndCollect(f)
    f.emit('assistant/chunk', 1, { chunk: { type: 'text-delta', text: 'A' } })
    await tick(); await tick(); await tick()
    assert.deepEqual(unhandled, [])
    assert.equal(calls, 2)
    assert.equal(f.updates[0]?.status, 'failed')
    assert.equal(events.at(-1)?.type, 'error')
    assert.equal(f.unsubscribeCalls, 1)
    assert.equal(f.reports[0], 'ai_stream_processing_failed')
    f.emit('assistant/chunk', 2, { chunk: { type: 'text-delta', text: 'B' } })
    await tick()
    assert.equal(calls, 2)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('history recovery rejection is contained without an unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const f = fixture()
  f.harness.history = async () => { throw new Error('history-failed') }
  try {
    const events = await startAndCollect(f)
    f.emit('session/subscribed', 5)
    await tick(); await tick(); await tick()
    assert.deepEqual(unhandled, [])
    assert.equal(f.updates.at(-1)?.status, 'failed')
    assert.equal(events.at(-1)?.type, 'error')
    assert.equal(f.unsubscribeCalls, 1)
    assert.equal(f.reports[0], 'ai_stream_processing_failed')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('cancel waits for an in-flight event before persisting terminal state', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  const f = fixture({
    updateMessage: async (_projectId, _conversationId, _messageId, input) => {
      writes += 1
      f.updates.push(input)
      if (writes === 1) await gate
      return { id: 'assistant-1' } as never
    },
  })
  await startAndCollect(f)
  f.emit('assistant/chunk', 1, { chunk: { type: 'text-delta', text: 'A' } })
  await tick()
  const cancelling = f.service.cancel('project-1', 'conversation-1')
  await tick()
  assert.equal(writes, 1)
  release()
  assert.equal(await cancelling, true)
  assert.deepEqual(f.updates.map(item => item.status), ['processing', 'cancelled'])
})

test('cancel rejection still disposes the active stream', async () => {
  const f = fixture()
  f.harness.cancel = async () => { throw new Error('cancel-failed') }
  await startAndCollect(f)
  await assert.rejects(f.service.cancel('project-1', 'conversation-1'), /cancel-failed/)
  assert.equal(f.unsubscribeCalls, 2, 'early unsubscribe and idempotent dispose unsubscribe')
  assert.equal(await f.service.cancel('project-1', 'conversation-1'), false)
})

test('stream listener rejection is isolated and reported', async () => {
  const f = fixture()
  await f.service.start('project-1', 'conversation-1', 'question', 'request-1')
  let delivered = 0
  assert.doesNotThrow(() => f.service.subscribe('project-1', 'conversation-1', 0, () => { throw new Error('replay-listener-failed') }))
  f.service.subscribe('project-1', 'conversation-1', 1, () => { throw new Error('listener-failed') })
  f.service.subscribe('project-1', 'conversation-1', 1, () => { delivered += 1 })
  f.emit('tool/call', 1, { name: 'test' })
  await tick(); await tick()
  assert.equal(delivered, 1)
  assert.equal(f.reports.at(-1), 'ai_stream_listener_failed')
})

test('failure persistence rejection is swallowed and cleanup still occurs once', async () => {
  let calls = 0
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const f = fixture({ updateMessage: async () => { calls += 1; throw new Error(`db-${calls}`) } })
  try {
    const events = await startAndCollect(f)
    f.emit('assistant/chunk', 1, { chunk: { type: 'text-delta', text: 'A' } })
    f.emit('assistant/chunk', 2, { chunk: { type: 'text-delta', text: 'B' } })
    await tick(); await tick(); await tick()
    assert.deepEqual(unhandled, [])
    assert.equal(calls, 2, 'one processing write and one failure persistence attempt')
    assert.equal(f.unsubscribeCalls, 1)
    assert.equal(events.filter(event => event.type === 'error').length, 1)
    assert.deepEqual(f.reports, ['ai_stream_processing_failed', 'ai_stream_failure_persistence_failed'])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgronHarnessClient, AgronMuxClient } from './agron-harness.ts'

async function fixture(mode: 'normal' | 'hold' | 'broken' = 'normal') {
  const dir = await mkdtemp(join(tmpdir(), 'agron-test-'))
  await writeFile(join(dir, 'key'), 'test-private-key\n')
  let request: any
  let closed = false
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-private-key')
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'huiwen-2-agron:latest' }] })); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    request = JSON.parse(Buffer.concat(chunks).toString())
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.on('close', () => { closed = true })
    if (mode === 'broken') { res.end('data: {"choices":[{"delta":{"content":"不完整"}}]}\n\n'); return }
    const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"中文结论"}}]}\n\n')
    // Split inside a Chinese UTF-8 codepoint, not just at a line boundary.
    const split = bytes.indexOf(Buffer.from('中')) + 1
    res.write(bytes.subarray(0, split))
    setTimeout(() => {
      res.write(bytes.subarray(split))
      if (mode !== 'hold') res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }, 10)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const client = new AgronHarnessClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyFile: join(dir, 'key'), maxTokens: 1024, answerTimeoutMs: 1000 })
  return { client, mux: new AgronMuxClient(client), request: () => request, closed: () => closed,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true }) } }
}

test('Agron preserves authenticated model selection, fragmented text and ordered stream history', async () => {
  const f = await fixture()
  try {
    const session = await f.client.createSession()
    assert.deepEqual(f.client.selection, { provider: 'agron-local', model: 'huiwen-2-agron:latest' })
    const frames: any[] = []
    let end!: () => void
    const ended = new Promise<void>(resolve => { end = resolve })
    f.mux.subscribe(session.sessionId, frame => { frames.push(frame); if (frame.event.type === 'turn/end') end() })
    assert.deepEqual(await f.client.sendPrompt(session.sessionId, '只分析授权项目事实'), { accepted: true })
    await ended
    assert.equal(f.request().model, 'huiwen-2-agron:latest')
    assert.equal(f.request().max_tokens, 1024)
    assert.equal(f.request().messages.at(-1).content, '只分析授权项目事实')
    assert.equal(frames.filter(f => f.event.type === 'assistant/chunk').map(f => f.event.data.chunk.text).join(''), '中文结论')
    assert.equal(frames.at(-1).event.data.reason.kind, 'completed')
    const seqs = frames.map(f => f.event.seq)
    assert.deepEqual(seqs, Array.from({ length: frames.length }, (_, index) => index + 1))
    const page = await f.client.history(session.sessionId, 2)
    assert.equal(page.hasMore, true)
    const older = await f.client.history(session.sessionId, 100, page.events[0].event!.seq)
    assert.equal(older.events[0].event!.type, 'turn/start')
    const result = await f.client.promptAndWait(session.sessionId, '继续分析', seqs.at(-1))
    assert.equal(result.text, '中文结论')
    assert.ok(result.lastEventSeq > seqs.at(-1)!)
    await f.client.archive(session.sessionId)
    assert.equal((await f.client.history(session.sessionId)).events.length, 0)
  } finally { await f.close() }
})

test('Agron cancellation aborts the actual HTTP request and never completes the turn', async () => {
  const f = await fixture('hold')
  try {
    const session = await f.client.createSession()
    let received!: () => void; let ended!: () => void
    const first = new Promise<void>(resolve => { received = resolve })
    const done = new Promise<void>(resolve => { ended = resolve })
    let reason: string | undefined
    f.mux.subscribe(session.sessionId, frame => {
      if (frame.event.type === 'assistant/chunk') received()
      if (frame.event.type === 'turn/end') { reason = String((frame.event.data.reason as any).kind); ended() }
    })
    await f.client.sendPrompt(session.sessionId, '等待取消')
    await first; await f.client.cancel(session.sessionId); await done
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(reason, 'aborted')
    assert.equal(f.closed(), true)
  } finally { await f.close() }
})

test('Agron rejects a disconnected stream instead of saving partial text as completed', async () => {
  const f = await fixture('broken')
  try {
    const session = await f.client.createSession()
    await assert.rejects(f.client.promptAndWait(session.sessionId, '分析'), /incomplete|截断/)
    const history = await f.client.history(session.sessionId)
    assert.equal((history.events.at(-1)?.event?.data?.reason as any).kind, 'failed')
  } finally { await f.close() }
})

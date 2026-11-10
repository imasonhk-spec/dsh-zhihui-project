import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessMuxClient, type HarnessMuxRuntime } from './harness-mux.ts'

type MessageListener = (event: { data: unknown }) => void
type SignalListener = () => void

class FakeSocket {
  readonly listeners = new Map<string, Array<MessageListener | SignalListener>>()
  closeCalls = 0
  recursiveCloseEvents = false

  addEventListener(type: 'message', listener: MessageListener): void
  addEventListener(type: 'close' | 'error', listener: SignalListener): void
  addEventListener(type: string, listener: MessageListener | SignalListener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: 'message', data: unknown): void
  emit(type: 'close' | 'error'): void
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      if (type === 'message') (listener as MessageListener)({ data })
      else (listener as SignalListener)()
    }
  }

  close() {
    this.closeCalls += 1
    if (this.recursiveCloseEvents) {
      this.emit('error')
      this.emit('close')
    }
  }
}

function fixture() {
  const sockets: FakeSocket[] = []
  const timers = new Map<number, () => void>()
  const cleared: number[] = []
  let nextTimer = 1
  const runtime: HarnessMuxRuntime = {
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    setReconnect: callback => {
      const id = nextTimer++
      timers.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearReconnect: handle => {
      const id = handle as unknown as number
      cleared.push(id)
      timers.delete(id)
    },
  }
  const fireNextTimer = () => {
    const entry = timers.entries().next().value as [number, () => void] | undefined
    assert.ok(entry, 'expected a pending reconnect timer')
    timers.delete(entry[0])
    entry[1]()
  }
  return { client: new HarnessMuxClient('ws://test/events', runtime), sockets, timers, cleared, fireNextTimer }
}

test('error and close share one disconnect without recursive close', () => {
  const { client, sockets, timers } = fixture()
  client.start()
  client.start()
  assert.equal(sockets.length, 1)

  const first = sockets[0]!
  first.recursiveCloseEvents = true
  first.emit('error')
  first.emit('error')
  first.emit('close')

  assert.equal(first.closeCalls, 0, 'error handling must never call close')
  assert.equal(timers.size, 1, 'one socket may schedule only one reconnect')
})

test('reconnect replaces the socket and ignores late old-socket events', () => {
  const { client, sockets, timers, fireNextTimer } = fixture()
  client.start()
  const first = sockets[0]!
  first.emit('close')
  assert.equal(timers.size, 1)

  fireNextTimer()
  assert.equal(sockets.length, 2)
  assert.equal(timers.size, 0)

  first.emit('error')
  first.emit('close')
  assert.equal(timers.size, 0, 'late events from an old socket must not affect the current connection')

  sockets[1]!.emit('close')
  assert.equal(timers.size, 1)
})

test('stop cancels reconnect and tolerates synchronous error-close events', () => {
  const { client, sockets, timers, cleared } = fixture()
  client.start()
  const socket = sockets[0]!
  socket.emit('error')
  assert.equal(timers.size, 1)

  client.stop()
  assert.equal(timers.size, 0)
  assert.equal(cleared.length, 1)
  assert.equal(socket.closeCalls, 0, 'a socket already disconnected by error is not closed again')

  client.start()
  assert.equal(sockets.length, 1, 'stop is terminal and prevents reconnect')
})

test('stop closes an active socket once without scheduling reconnect', () => {
  const { client, sockets, timers } = fixture()
  client.start()
  const socket = sockets[0]!
  socket.recursiveCloseEvents = true

  client.stop()

  assert.equal(socket.closeCalls, 1)
  assert.equal(timers.size, 0)
  socket.emit('error')
  socket.emit('close')
  assert.equal(timers.size, 0)
})

test('subscriptions receive valid frames and unsubscribe cleanly', () => {
  const { client, sockets } = fixture()
  const received: unknown[] = []
  const unsubscribe = client.subscribe('session-1', event => received.push(event))
  const socket = sockets[0]!

  socket.emit('message', JSON.stringify({ type: 'server-request', payload: { sessionId: 'session-1', type: 'session/subscribed', lastSeq: 4 } }))
  socket.emit('message', JSON.stringify({ type: 'server-request', payload: { sessionId: 'session-1', type: 'session/event', event: { type: 'assistant/chunk', seq: 5, data: { text: 'ok' } }, view: { safe: true } } }))
  socket.emit('message', '{invalid')
  assert.equal(received.length, 2)

  unsubscribe()
  socket.emit('message', JSON.stringify({ type: 'server-request', payload: { sessionId: 'session-1', type: 'session/event', event: { type: 'turn/end', seq: 6, data: {} } } }))
  assert.equal(received.length, 2)
})

test('socket constructor failure schedules one retry instead of throwing', () => {
  const timers = new Map<number, () => void>()
  let attempts = 0
  const runtime: HarnessMuxRuntime = {
    createSocket: () => { attempts += 1; throw new Error('invalid-url') },
    setReconnect: callback => { timers.set(1, callback); return 1 as unknown as ReturnType<typeof setTimeout> },
    clearReconnect: () => { timers.delete(1) },
  }
  const client = new HarnessMuxClient('invalid', runtime)
  assert.doesNotThrow(() => client.start())
  client.start()
  assert.equal(attempts, 1)
  assert.equal(timers.size, 1)
})

test('listener failure is isolated from other listeners', () => {
  const { client, sockets } = fixture()
  let delivered = 0
  client.subscribe('session-1', () => { throw new Error('consumer-failed') })
  client.subscribe('session-1', () => { delivered += 1 })
  sockets[0]!.emit('message', JSON.stringify({ type: 'server-request', payload: { sessionId: 'session-1', type: 'session/event', event: { type: 'turn/end', seq: 1, data: {} } } }))
  assert.equal(delivered, 1)
})

test('late message is ignored and subscription survives reconnect', () => {
  const { client, sockets, fireNextTimer } = fixture()
  let delivered = 0
  client.subscribe('session-1', () => { delivered += 1 })
  const first = sockets[0]!
  first.emit('close')
  fireNextTimer()
  first.emit('message', JSON.stringify({ type: 'server-request', payload: { sessionId: 'session-1', type: 'session/subscribed', lastSeq: 1 } }))
  assert.equal(delivered, 0)
  sockets[1]!.emit('message', JSON.stringify({ type: 'server-request', payload: { sessionId: 'session-1', type: 'session/subscribed', lastSeq: 2 } }))
  assert.equal(delivered, 1)
})

test('close-error reverse order still schedules one reconnect', () => {
  const { client, sockets, timers } = fixture()
  client.start()
  sockets[0]!.emit('close')
  sockets[0]!.emit('error')
  assert.equal(timers.size, 1)
})

test('subscribe after stop is inert', () => {
  const { client, sockets } = fixture()
  client.start()
  client.stop()
  let delivered = 0
  const unsubscribe = client.subscribe('session-1', () => { delivered += 1 })
  unsubscribe()
  assert.equal(sockets.length, 1)
  assert.equal(delivered, 0)
})

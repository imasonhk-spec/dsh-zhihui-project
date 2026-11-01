export type HarnessMuxEvent = {
  sessionId: string
  event: { type: string; seq: number; time?: number; data: Record<string, unknown> }
  view?: unknown
}
export type HarnessMuxListener = (event: HarnessMuxEvent) => void

type MuxSocket = {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close' | 'error', listener: () => void): void
  close(): void
}
type TimerHandle = ReturnType<typeof setTimeout>
export type HarnessMuxRuntime = {
  createSocket: (url: string) => MuxSocket
  setReconnect: (callback: () => void, delayMs: number) => TimerHandle
  clearReconnect: (handle: TimerHandle) => void
}

const defaultRuntime: HarnessMuxRuntime = {
  createSocket: url => new WebSocket(url) as MuxSocket,
  setReconnect: (callback, delayMs) => setTimeout(callback, delayMs),
  clearReconnect: handle => clearTimeout(handle),
}

export class HarnessMuxClient {
  private socket?: MuxSocket
  private stopped = false
  private reconnect?: TimerHandle
  private disconnected = new WeakSet<object>()
  private listeners = new Map<string, Set<HarnessMuxListener>>()

  constructor(
    private readonly url = process.env.DSH_EVENTS_URL ?? 'ws://127.0.0.1:3080/api/events.mux',
    private readonly runtime: HarnessMuxRuntime = defaultRuntime,
  ) {}

  start() {
    if (this.stopped) return
    this.connect()
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.reconnect) {
      this.runtime.clearReconnect(this.reconnect)
      this.reconnect = undefined
    }
    const socket = this.socket
    this.socket = undefined
    if (socket) {
      this.disconnected.add(socket as object)
      try { socket.close() } catch { /* stopping is best effort */ }
    }
  }

  subscribe(sessionId: string, listener: HarnessMuxListener) {
    if (this.stopped) return () => {}
    let set = this.listeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(listener)
    if (!this.socket) this.start()
    return () => {
      set!.delete(listener)
      if (!set!.size) this.listeners.delete(sessionId)
    }
  }

  private connect() {
    if (this.stopped || this.socket || this.reconnect) return
    let socket: MuxSocket
    try {
      socket = this.runtime.createSocket(this.url)
    } catch {
      if (!this.stopped && !this.reconnect) {
        this.reconnect = this.runtime.setReconnect(() => {
          this.reconnect = undefined
          this.connect()
        }, 1000)
      }
      return
    }
    this.socket = socket

    socket.addEventListener('message', message => {
      if (this.socket !== socket || this.stopped) return
      try {
        const value = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data)) as { type?: string; payload?: Record<string, unknown> }
        const payload = value.payload
        if (value.type !== 'server-request' || !payload || typeof payload.sessionId !== 'string') return
        if (payload.type === 'session/subscribed' && typeof payload.lastSeq === 'number') {
          const normalized: HarnessMuxEvent = { sessionId: payload.sessionId, event: { type: 'session/subscribed', seq: payload.lastSeq, data: { lastSeq: payload.lastSeq } } }
          this.deliver(payload.sessionId, normalized)
          return
        }
        if (payload.type !== 'session/event' || !payload.event || typeof payload.event !== 'object') return
        const event = payload.event as Record<string, unknown>
        if (typeof event.type !== 'string' || typeof event.seq !== 'number' || !event.data || typeof event.data !== 'object') return
        const normalized: HarnessMuxEvent = {
          sessionId: payload.sessionId,
          event: { type: event.type, seq: event.seq, time: typeof event.time === 'number' ? event.time : undefined, data: event.data as Record<string, unknown> },
          view: payload.view,
        }
        this.deliver(payload.sessionId, normalized)
      } catch { /* invalid frames are ignored */ }
    })

    const disconnect = () => this.disconnect(socket)
    socket.addEventListener('close', disconnect)
    socket.addEventListener('error', disconnect)
  }

  private deliver(sessionId: string, event: HarnessMuxEvent) {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try { listener(event) } catch { /* one consumer must not block the others */ }
    }
  }

  private disconnect(socket: MuxSocket) {
    if (this.disconnected.has(socket as object)) return
    this.disconnected.add(socket as object)
    if (this.socket !== socket) return
    this.socket = undefined
    if (this.stopped || this.reconnect) return
    this.reconnect = this.runtime.setReconnect(() => {
      this.reconnect = undefined
      this.connect()
    }, 1000)
  }
}

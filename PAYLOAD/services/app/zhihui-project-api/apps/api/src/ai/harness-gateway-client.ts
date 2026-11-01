/**
 * Isolated, transport-agnostic adapter for Harness events.mux frames.
 * This module deliberately has no Fastify/controller dependency; production
 * routing remains owned by harness-mux.ts and can adopt this contract later.
 */
export type HarnessGatewayEvent = {
  sessionId: string
  event: { type: string; seq: number; time?: number; data: Record<string, unknown> }
  view?: unknown
}

type RecordLike = Record<string, unknown>

function record(value: unknown): RecordLike | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordLike
    : undefined
}

/** Normalize one events.mux server-request frame; invalid frames are ignored. */
export function normalizeHarnessGatewayFrame(value: unknown): HarnessGatewayEvent | undefined {
  const frame = record(value)
  if (frame?.type !== 'server-request') return undefined
  const payload = record(frame.payload)
  if (payload === undefined || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) return undefined
  if (payload.type === 'session/subscribed') {
    if (!Number.isSafeInteger(payload.lastSeq) || (payload.lastSeq as number) < -1) return undefined
    const lastSeq = payload.lastSeq as number
    return { sessionId: payload.sessionId, event: { type: 'session/subscribed', seq: lastSeq, data: { lastSeq } } }
  }
  if (payload.type !== 'session/event') return undefined
  const event = record(payload.event)
  if (event === undefined || typeof event.type !== 'string' || event.type.length === 0
    || !Number.isSafeInteger(event.seq) || (event.seq as number) < 0) return undefined
  const data = record(event.data)
  if (data === undefined) return undefined
  const normalized: HarnessGatewayEvent = {
    sessionId: payload.sessionId,
    event: { type: event.type, seq: event.seq as number, data },
  }
  if (typeof event.time === 'number' && Number.isFinite(event.time)) normalized.event.time = event.time
  if (payload.view !== undefined) normalized.view = payload.view
  return normalized
}

/** A tiny sequence gate used by fixtures and consumers before event handling. */
export function acceptHarnessGatewaySequence(lastSeq: number, nextSeq: number): 'duplicate' | 'contiguous' | 'gap' {
  if (!Number.isSafeInteger(lastSeq) || !Number.isSafeInteger(nextSeq)) throw new TypeError('sequence must be safe integers')
  if (nextSeq <= lastSeq) return 'duplicate'
  return nextSeq === lastSeq + 1 ? 'contiguous' : 'gap'
}

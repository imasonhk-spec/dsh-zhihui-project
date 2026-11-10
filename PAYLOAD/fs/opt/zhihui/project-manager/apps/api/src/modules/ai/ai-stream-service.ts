import { EventEmitter } from 'node:events'
import { sanitizeModelOutput, type DeepSeekHarnessClient } from '../../ai/deepseek-harness.ts'
import type { HarnessMuxClient, HarnessMuxEvent } from '../../ai/harness-mux.ts'
import {
  createProjectAiExchange,
  finalizeProjectAiStreamAnswer,
  getProjectAiConversation,
  getProjectAiMessage,
  listProjectAiMessages,
  updateProjectAiStreamMessage,
  type CitationCreate,
} from './ai-conversation-service.ts'
import { prepareProjectRag, selectCitedEvidence } from './rag-answer-service.ts'
import type { RagDocumentEvidence } from './rag-prompt.ts'

export type AiStreamEvent = { id: number; type: 'started' | 'delta' | 'tool' | 'completed' | 'error' | 'cancelled'; messageId: string; data: Record<string, unknown> }
type PreparedRag = Awaited<ReturnType<typeof prepareProjectRag>>
type Exchange = Awaited<ReturnType<typeof createProjectAiExchange>>
type Conversation = Awaited<ReturnType<typeof getProjectAiConversation>>
type Message = Awaited<ReturnType<typeof getProjectAiMessage>>
type StartResult = Exchange | { userMessage: undefined; assistantMessage: Message; duplicate: true } | undefined
type HistoryEvent = NonNullable<Awaited<ReturnType<DeepSeekHarnessClient['history']>>['events'][number]['event']> & { seq: number }

type Active = {
  projectId: string
  conversationId: string
  messageId: string
  sessionId: string
  requestId: string
  evidence: RagDocumentEvidence[]
  text: string
  rawText: string
  lastSeq: number
  turn?: number
  awaitingTurnStart: boolean
  events: AiStreamEvent[]
  emitter: EventEmitter
  unsubscribe: () => void
  queue: Promise<void>
  terminating: boolean
  failureHandled: boolean
}

export type AiStreamDependencies = {
  getConversation: (projectId: string, conversationId: string) => Promise<Conversation>
  getMessage: (projectId: string, conversationId: string, messageId: string) => Promise<Message>
  listMessages: typeof listProjectAiMessages
  prepareRag: (projectId: string, conversationId: string, question: string) => Promise<PreparedRag>
  createExchange: (projectId: string, conversationId: string, question: string, requestId: string, metadata: Record<string, unknown>) => Promise<Exchange>
  updateMessage: typeof updateProjectAiStreamMessage
  finalizeAnswer: typeof finalizeProjectAiStreamAnswer
  selectEvidence: (answer: string, evidence: RagDocumentEvidence[]) => CitationCreate[]
  reportBackgroundError: (code: string) => void
  scheduleEmitterCleanup: (callback: () => void) => void
}

const defaultDependencies: AiStreamDependencies = {
  getConversation: getProjectAiConversation,
  getMessage: getProjectAiMessage,
  listMessages: listProjectAiMessages,
  prepareRag: prepareProjectRag,
  createExchange: createProjectAiExchange,
  updateMessage: updateProjectAiStreamMessage,
  finalizeAnswer: finalizeProjectAiStreamAnswer,
  selectEvidence: selectCitedEvidence,
  reportBackgroundError: code => console.error(`[ai-stream] ${code}`),
  scheduleEmitterCleanup: callback => { setTimeout(callback, 30_000) },
}

export class AiStreamService {
  private active = new Map<string, Active>()
  private starting = new Map<string, Promise<StartResult>>()

  constructor(
    private harness: DeepSeekHarnessClient,
    private mux: HarnessMuxClient,
    private deps: AiStreamDependencies = defaultDependencies,
  ) {}

  async start(projectId: string, conversationId: string, question: string, requestId: string): Promise<StartResult> {
    const pending = this.starting.get(conversationId)
    if (pending) return pending
    const operation = this.startLocked(projectId, conversationId, question, requestId)
    this.starting.set(conversationId, operation)
    try { return await operation } finally {
      if (this.starting.get(conversationId) === operation) this.starting.delete(conversationId)
    }
  }

  private async startLocked(projectId: string, conversationId: string, question: string, requestId: string): Promise<StartResult> {
    const conversation = await this.deps.getConversation(projectId, conversationId)
    if (!conversation) return undefined
    if (!conversation.harnessSessionId) throw new Error('ai_conversation_session_missing')
    const existing = this.active.get(conversationId)
    if (existing) return { userMessage: undefined, assistantMessage: await this.deps.getMessage(projectId, conversationId, existing.messageId), duplicate: true }
    const prepared = await this.deps.prepareRag(projectId, conversationId, question)
    const exchange = await this.deps.createExchange(projectId, conversationId, question, requestId, {
      answerMode: prepared.evidence.length ? 'rag' : 'business_context',
      evidenceCount: prepared.evidence.length,
      retrievalMode: prepared.retrieval.mode,
      degraded: prepared.degraded,
      promptTruncated: prepared.truncated,
    })
    if (exchange.duplicate) return exchange
    if (!exchange.userMessage || !exchange.assistantMessage) throw new Error('ai_exchange_create_failed')
    const lastSeq = await this.currentSequenceBaseline(conversation.harnessSessionId, conversation.lastEventSeq)
    const active: Active = {
      projectId,
      conversationId,
      messageId: exchange.assistantMessage.id,
      sessionId: conversation.harnessSessionId,
      requestId,
      evidence: prepared.evidence,
      text: '',
      rawText: '',
      lastSeq,
      awaitingTurnStart: lastSeq > 0,
      events: [],
      emitter: new EventEmitter(),
      unsubscribe: () => {},
      queue: Promise.resolve(),
      terminating: false,
      failureHandled: false,
    }
    active.unsubscribe = this.mux.subscribe(active.sessionId, event => this.enqueue(active, event))
    this.active.set(conversationId, active)
    this.emit(active, 'started', { requestId })
    try {
      await this.harness.sendPrompt(active.sessionId, prepared.prompt, requestId)
    } catch (error) {
      await this.failAndDispose(active, errorCode(error, 'harness_prompt_failed'))
      throw error
    }
    return exchange
  }

  subscribe(projectId: string, conversationId: string, afterId: number, listener: (event: AiStreamEvent) => void) {
    const active = this.active.get(conversationId)
    if (!active || active.projectId !== projectId) return () => {}
    for (const event of active.events) if (event.id > afterId) this.deliverToListener(listener, event)
    active.emitter.on('event', listener)
    return () => active.emitter.off('event', listener)
  }

  async cancel(projectId: string, conversationId: string) {
    const active = this.active.get(conversationId)
    if (!active || active.projectId !== projectId) return false
    active.terminating = true
    active.unsubscribe()
    const operation = active.queue.then(async () => {
      try {
        await this.harness.cancel(active.sessionId)
        await this.deps.updateMessage(projectId, conversationId, active.messageId, {
          content: active.text || '生成已停止。', status: 'cancelled', errorCode: 'harness_cancelled', lastEventSeq: active.lastSeq,
        })
        this.emit(active, 'cancelled', { content: active.text })
        return true
      } finally {
        this.dispose(active)
      }
    })
    active.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async retry(projectId: string, conversationId: string, messageId: string, requestId: string) {
    const message = await this.deps.getMessage(projectId, conversationId, messageId)
    if (!message || message.role !== 'assistant' || !['failed', 'cancelled'].includes(message.status)) return undefined
    const list = await this.deps.listMessages(projectId, conversationId, { limit: '200' })
    const user = [...(list?.items ?? [])].reverse().find(item => item.role === 'user' && item.sequence < message.sequence)
    if (!user) throw new Error('ai_retry_source_not_found')
    return this.start(projectId, conversationId, user.content, requestId)
  }

  private async currentSequenceBaseline(sessionId: string, persistedLastSeq: number) {
    if (persistedLastSeq <= 0) return persistedLastSeq
    const history = await this.harness.history(sessionId, 1)
    const currentLastSeq = (history.events ?? []).reduce((value, entry) => Math.max(value, entry.event?.seq ?? 0), 0)
    return currentLastSeq < persistedLastSeq ? 0 : persistedLastSeq
  }

  private enqueue(active: Active, frame: HarnessMuxEvent) {
    if (active.terminating || this.active.get(active.conversationId) !== active) return
    active.queue = active.queue
      .then(() => this.handle(active, frame))
      .catch(error => this.containFailure(active, error))
  }

  private async containFailure(active: Active, error: unknown) {
    if (active.failureHandled || active.terminating) return
    active.failureHandled = true
    active.terminating = true
    void error
    this.deps.reportBackgroundError('ai_stream_processing_failed')
    try {
      await this.deps.updateMessage(active.projectId, active.conversationId, active.messageId, {
        content: active.text || '项目智能助手暂时无法完成回答，请稍后重试。',
        status: 'failed',
        errorCode: 'ai_stream_processing_failed',
        lastEventSeq: active.lastSeq,
        metadata: { requestId: active.requestId, retryable: true },
      })
    } catch {
      this.deps.reportBackgroundError('ai_stream_failure_persistence_failed')
    } finally {
      this.emit(active, 'error', { code: 'ai_stream_processing_failed', content: active.text })
      this.dispose(active)
    }
  }

  private async handle(active: Active, frame: HarnessMuxEvent, fromRecovery = false) {
    if (active.terminating || this.active.get(active.conversationId) !== active || frame.sessionId !== active.sessionId) return
    if (frame.event.type === 'session/subscribed') {
      if (!fromRecovery && frame.event.seq > active.lastSeq) await this.recover(active, active.lastSeq)
      return
    }
    if (frame.event.seq <= active.lastSeq) return
    if (!fromRecovery && frame.event.seq > active.lastSeq + 1) await this.recover(active, active.lastSeq)
    if (active.terminating || frame.event.seq <= active.lastSeq) return
    active.lastSeq = frame.event.seq
    const { type, data } = frame.event
    if (type === 'turn/start' && typeof data.turn === 'number') { active.turn = data.turn; active.awaitingTurnStart = false; return }
    if (active.awaitingTurnStart) return
    if (type === 'assistant/chunk') {
      const chunk = data.chunk as { type?: string; text?: string } | undefined
      if (chunk?.type === 'text-delta' && chunk.text) {
        active.rawText += chunk.text
        const safe=sanitizeModelOutput(active.rawText)
        if(safe){const delta=safe.startsWith(active.text)?safe.slice(active.text.length):safe;active.text=safe;await this.deps.updateMessage(active.projectId, active.conversationId, active.messageId, { content: active.text, status: 'processing', lastEventSeq: active.lastSeq });if(delta&&!active.terminating&&this.active.get(active.conversationId)===active)this.emit(active,'delta',{text:delta,content:active.text})}
      }
      return
    }
    if (type === 'tool/call' || type === 'tool/result') { this.emit(active, 'tool', { eventType: type, name: data.name, view: frame.view }); return }
    if (type === 'assistant/message') { const text = extractText(data.message); if (text) { active.rawText=text; active.text=sanitizeModelOutput(text) } return }
    if (type === 'turn/end' && (!active.turn || data.turn === active.turn)) {
      const kind = typeof data.reason === 'object' && data.reason ? String((data.reason as { kind?: unknown }).kind) : String(data.reason ?? 'completed')
      if (kind === 'completed' && active.text) {
        active.text = sanitizeModelOutput(active.text)
        if (!active.text) { await this.failAndDispose(active, 'harness_unsafe_answer'); return }
        const cited = this.deps.selectEvidence(active.text, active.evidence)
        const message = await this.deps.finalizeAnswer(active.projectId, active.conversationId, active.messageId, {
          content: active.text,
          citations: cited,
          metadata: { requestId: active.requestId, evidenceCount: active.evidence.length, citationCount: cited.length, turnReason: kind },
          harnessEventSeq: frame.event.seq,
          lastEventSeq: frame.event.seq,
        })
        if (!active.terminating && this.active.get(active.conversationId) === active) {
          this.emit(active, 'completed', { message })
          this.dispose(active)
        }
      } else {
        const code = kind === 'completed' ? 'harness_empty_answer' : kind === 'aborted' ? 'harness_aborted' : 'harness_turn_failed'
        await this.failAndDispose(active, code)
      }
    }
  }

  private async recover(active: Active, afterSeq: number) {
    const recovered = new Map<number, HistoryEvent>()
    let beforeSeq: number | undefined
    const maxPages = 20
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const history = await this.harness.history(active.sessionId, 100, beforeSeq)
      const pageEvents = (history.events ?? [])
        .map(item => item.event)
        .filter((event): event is HistoryEvent => Boolean(event) && typeof event!.seq === 'number')
      for (const event of pageEvents) if (event.seq > afterSeq && !recovered.has(event.seq)) recovered.set(event.seq, event)
      const oldestSeq = pageEvents.reduce<number | undefined>((oldest, event) => oldest === undefined || event.seq < oldest ? event.seq : oldest, undefined)
      if (!history.hasMore) break
      if (oldestSeq === undefined) throw new Error('ai_stream_history_no_progress')
      if (oldestSeq <= afterSeq) break
      if (beforeSeq !== undefined && oldestSeq >= beforeSeq) throw new Error('ai_stream_history_no_progress')
      beforeSeq = oldestSeq
      if (pageNumber === maxPages - 1) throw new Error('ai_stream_history_page_limit')
    }
    const events = [...recovered.values()].sort((a, b) => a.seq - b.seq)
    for (const event of events) {
      if (active.terminating) return
      await this.handle(active, { sessionId: active.sessionId, event: { type: event.type ?? '', seq: event.seq, data: event.data ?? {} } }, true)
    }
  }

  private emit(active: Active, type: AiStreamEvent['type'], data: Record<string, unknown>) {
    const event = { id: active.events.length ? active.events.at(-1)!.id + 1 : 1, type, messageId: active.messageId, data }
    active.events.push(event)
    if (active.events.length > 500) active.events.shift()
    for (const listener of active.emitter.listeners('event')) this.deliverToListener(listener as (value: AiStreamEvent) => void, event)
  }

  private deliverToListener(listener: (event: AiStreamEvent) => void, event: AiStreamEvent) {
    try { listener(event) } catch { this.deps.reportBackgroundError('ai_stream_listener_failed') }
  }

  private async failAndDispose(active: Active, code: string) {
    if (active.terminating) return
    active.terminating = true
    try {
      await this.deps.updateMessage(active.projectId, active.conversationId, active.messageId, {
        content: active.text || '项目智能助手暂时无法完成回答，请稍后重试。',
        status: 'failed', errorCode: code, lastEventSeq: active.lastSeq,
        metadata: { requestId: active.requestId, retryable: true },
      })
      this.emit(active, 'error', { code, content: active.text })
    } finally {
      this.dispose(active)
    }
  }

  private dispose(active: Active) {
    active.terminating = true
    active.unsubscribe()
    if (this.active.get(active.conversationId) === active) this.active.delete(active.conversationId)
    this.deps.scheduleEmitterCleanup(() => active.emitter.removeAllListeners())
  }
}

function errorCode(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function extractText(message: unknown) {
  if (!message || typeof message !== 'object' || !Array.isArray((message as { content?: unknown }).content)) return ''
  return ((message as { content: unknown[] }).content).map(block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '').join('').trim()
}

import { and, asc, desc, eq, gt, lt, max, sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { aiCitations, aiConversations, aiMessageFeedback, aiMessages, documentChunks, documents, documentVersions, projects } from '../../db/schema.ts'

export type ConversationListFilters = { status?: string; limit?: string; cursor?: string }
export type MessageListFilters = { limit?: string; before?: string; after?: string }
export type ConversationUpdate = { title?: string; status?: string }
export type MessageCreate = { role?: string; content?: string; status?: string; metadata?: Record<string, unknown>; requestId?:string; harnessEventSeq?:number }
export type CitationCreate = { sourceProjectId:string;sourceProjectCode:string;documentId:string;versionId:string;versionNumber:string;chunkId:string;chunkIndex:number;checksum:string|null;capturedAt:string;snippet:string;pageNumber:number|null;sectionPath:string|null;score:number }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const conversationStatuses = new Set(['active', 'archived'])
const messageRoles = new Set(['system', 'user', 'assistant', 'tool'])
const messageStatuses = new Set(['pending', 'processing', 'completed', 'failed', 'cancelled'])

export async function listProjectAiConversations(projectId: string, filters: ConversationListFilters = {}) {
  await assertProject(projectId)
  const status = filters.status || 'active'
  if (!conversationStatuses.has(status)) throw new Error('ai_conversation_status_invalid')
  const limit = parseLimit(filters.limit, 20, 100)
  const cursor = filters.cursor ? parseDate(filters.cursor, 'ai_conversation_cursor_invalid') : undefined
  const where = and(eq(aiConversations.projectId, projectId), eq(aiConversations.status, status as never), cursor ? lt(aiConversations.updatedAt, cursor) : undefined)
  const rows = await db.select().from(aiConversations).where(where).orderBy(desc(aiConversations.updatedAt), desc(aiConversations.id)).limit(limit + 1)
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  return { items, hasMore, nextCursor: hasMore ? items.at(-1)?.updatedAt.toISOString() : null }
}

export async function createProjectAiConversation(projectId: string, input: { title?: string } = {}) {
  await assertProject(projectId)
  assertBody(input)
  const title = normalizeTitle(input.title)
  const [row] = await db.insert(aiConversations).values({ projectId, title }).returning()
  return row
}

export async function getProjectAiConversation(projectId: string, conversationId: string) {
  assertUuid(conversationId, 'ai_conversation_id_invalid')
  const [row] = await db.select().from(aiConversations).where(and(eq(aiConversations.id, conversationId), eq(aiConversations.projectId, projectId))).limit(1)
  return row
}

export async function updateProjectAiConversation(projectId: string, conversationId: string, input: ConversationUpdate) {
  assertBody(input)
  const keys = Object.keys(input)
  if (!keys.length || keys.some(key => !['title', 'status'].includes(key))) throw new Error('ai_conversation_field_invalid')
  const existing = await getProjectAiConversation(projectId, conversationId)
  if (!existing) return undefined
  const title = input.title === undefined ? existing.title : normalizeTitle(input.title)
  const status = input.status === undefined ? existing.status : input.status
  if (!conversationStatuses.has(status)) throw new Error('ai_conversation_status_invalid')
  if (title === existing.title && status === existing.status) return existing
  const [row] = await db.update(aiConversations).set({ title, status: status as never, updatedAt: new Date() }).where(and(eq(aiConversations.id, conversationId), eq(aiConversations.projectId, projectId))).returning()
  return row
}

export async function deleteProjectAiConversation(projectId: string, conversationId: string) {
  assertUuid(conversationId, 'ai_conversation_id_invalid')
  const [row] = await db.delete(aiConversations).where(and(eq(aiConversations.id, conversationId), eq(aiConversations.projectId, projectId))).returning({ id: aiConversations.id })
  return Boolean(row)
}

export async function listProjectAiMessages(projectId: string, conversationId: string, filters: MessageListFilters = {}) {
  const conversation = await getProjectAiConversation(projectId, conversationId)
  if (!conversation) return undefined
  if (filters.before && filters.after) throw new Error('ai_message_cursor_conflict')
  const limit = parseLimit(filters.limit, 50, 200)
  const before = filters.before ? parseSequence(filters.before) : undefined
  const after = filters.after ? parseSequence(filters.after) : undefined
  const where = and(eq(aiMessages.conversationId, conversationId), before ? lt(aiMessages.sequence, before) : undefined, after ? gt(aiMessages.sequence, after) : undefined)
  const rows = await db.select().from(aiMessages).where(where).orderBy(desc(aiMessages.sequence)).limit(limit + 1)
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).reverse()
  const citations = items.length ? await db.select({ id: aiCitations.id, messageId: aiCitations.messageId, documentId: aiCitations.documentId, versionId: aiCitations.versionId, chunkId: aiCitations.chunkId, sourceProjectId: sql<string|null>`coalesce(${aiCitations.sourceProjectId}, ${documents.projectId})`, sourceProjectCode: sql<string|null>`coalesce(${aiCitations.sourceProjectCode}, ${projects.code})`, sortOrder: aiCitations.sortOrder, snippet: aiCitations.snippet, pageNumber: aiCitations.pageNumber, sectionPath: aiCitations.sectionPath, score: aiCitations.score, documentName: documents.name, versionNumber: sql<string|null>`coalesce(${aiCitations.versionNumber}, ${documentVersions.versionNumber})`, chunkIndex: sql<number|null>`coalesce(${aiCitations.chunkIndex}, ${documentChunks.chunkIndex})`, checksum: sql<string|null>`coalesce(${aiCitations.checksum}, ${documentVersions.checksum}, ${documents.checksum})`, capturedAt: sql<Date>`coalesce(${aiCitations.capturedAt}, ${aiCitations.createdAt})` }).from(aiCitations).leftJoin(documents, eq(documents.id, aiCitations.documentId)).leftJoin(projects, eq(projects.id, documents.projectId)).leftJoin(documentVersions, eq(documentVersions.id, aiCitations.versionId)).leftJoin(documentChunks, eq(documentChunks.id, aiCitations.chunkId)).where(sql`${aiCitations.messageId} in ${items.map(item => item.id)}`).orderBy(asc(aiCitations.sortOrder)) : []
  const feedback=items.length?await db.select().from(aiMessageFeedback).where(sql`${aiMessageFeedback.messageId} in ${items.map(item=>item.id)}`):[]
  return { conversation, items: items.map(item => ({ ...item, citations: citations.filter(citation => citation.messageId === item.id),feedback:feedback.find(entry=>entry.messageId===item.id)??null })), hasMore, nextBefore: hasMore ? String(items[0]?.sequence) : null }
}

export async function createProjectAiMessage(projectId: string, conversationId: string, input: MessageCreate) {
  assertBody(input)
  const conversation = await getProjectAiConversation(projectId, conversationId)
  if (!conversation) return undefined
  const role = input.role ?? 'user'
  const status = input.status ?? 'completed'
  if (!messageRoles.has(role)) throw new Error('ai_message_role_invalid')
  if (!messageStatuses.has(status)) throw new Error('ai_message_status_invalid')
  const content = normalizeContent(input.content)
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new Error('ai_message_metadata_invalid')
  return db.transaction(async tx => {
    await tx.execute(sql`select ${aiConversations.id} from ${aiConversations} where ${aiConversations.id} = ${conversationId} and ${aiConversations.projectId} = ${projectId} for update`)
    const [sequenceRow] = await tx.select({ value: max(aiMessages.sequence) }).from(aiMessages).where(eq(aiMessages.conversationId, conversationId))
    const [message] = await tx.insert(aiMessages).values({ conversationId, role: role as never, status: status as never, content, sequence: (sequenceRow?.value ?? 0) + 1, requestId:input.requestId,harnessEventSeq:input.harnessEventSeq,metadata: input.metadata ?? {} }).returning()
    await tx.update(aiConversations).set({ updatedAt: new Date() }).where(and(eq(aiConversations.id, conversationId), eq(aiConversations.projectId, projectId)))
    return message
  })
}

export async function createProjectAiExchange(projectId:string,conversationId:string,question:string,requestId:string,metadata:Record<string,unknown>={}){const existing=await db.select().from(aiMessages).where(and(eq(aiMessages.conversationId,conversationId),eq(aiMessages.requestId,requestId))).orderBy(asc(aiMessages.sequence));if(existing.length)return{userMessage:existing.find(item=>item.role==='user'),assistantMessage:existing.find(item=>item.role==='assistant'),duplicate:true};const userMessage=await createProjectAiMessage(projectId,conversationId,{role:'user',content:question,status:'completed',requestId,metadata});const assistantMessage=await createProjectAiMessage(projectId,conversationId,{role:'assistant',content:'正在生成回答…',status:'processing',requestId:`${requestId}:answer`,metadata:{...metadata,requestId}});return{userMessage,assistantMessage,duplicate:false}}
export async function updateProjectAiStreamMessage(projectId:string,conversationId:string,messageId:string,input:{content?:string;status?:string;errorCode?:string|null;harnessEventSeq?:number;metadata?:Record<string,unknown>;lastEventSeq?:number}){const conversation=await getProjectAiConversation(projectId,conversationId);if(!conversation)return undefined;const values={...(input.content===undefined?{}:{content:input.content||'正在生成回答…'}),...(input.status===undefined?{}:{status:input.status as never}),...(input.errorCode===undefined?{}:{errorCode:input.errorCode}),...(input.harnessEventSeq===undefined?{}:{harnessEventSeq:input.harnessEventSeq}),...(input.metadata===undefined?{}:{metadata:input.metadata}),updatedAt:new Date()};const [row]=await db.update(aiMessages).set(values).where(and(eq(aiMessages.id,messageId),eq(aiMessages.conversationId,conversationId))).returning();if(row&&input.lastEventSeq!==undefined)await db.update(aiConversations).set({lastEventSeq:input.lastEventSeq,updatedAt:new Date()}).where(and(eq(aiConversations.id,conversationId),eq(aiConversations.projectId,projectId)));return row}
export async function getProjectAiMessage(projectId:string,conversationId:string,messageId:string){const conversation=await getProjectAiConversation(projectId,conversationId);if(!conversation)return undefined;const [row]=await db.select().from(aiMessages).where(and(eq(aiMessages.id,messageId),eq(aiMessages.conversationId,conversationId))).limit(1);return row}
export async function finalizeProjectAiStreamAnswer(projectId:string,conversationId:string,messageId:string,input:{content:string;citations:CitationCreate[];metadata:Record<string,unknown>;harnessEventSeq:number;lastEventSeq:number}){const conversation=await getProjectAiConversation(projectId,conversationId);if(!conversation)return undefined;return db.transaction(async tx=>{const [message]=await tx.update(aiMessages).set({content:normalizeContent(input.content),status:'completed',errorCode:null,harnessEventSeq:input.harnessEventSeq,metadata:input.metadata,updatedAt:new Date()}).where(and(eq(aiMessages.id,messageId),eq(aiMessages.conversationId,conversationId))).returning();if(!message)return undefined;await tx.delete(aiCitations).where(eq(aiCitations.messageId,messageId));const citations=input.citations.length?await tx.insert(aiCitations).values(input.citations.map((citation,index)=>citationValues(messageId,citation,index))).returning():[];await tx.update(aiConversations).set({lastEventSeq:input.lastEventSeq,updatedAt:new Date()}).where(and(eq(aiConversations.id,conversationId),eq(aiConversations.projectId,projectId)));return{...message,citations}})}

export async function completeProjectAiAnswer(projectId:string,conversationId:string,input:{content:string;citations:CitationCreate[];metadata?:Record<string,unknown>;lastEventSeq?:number}){
  const conversation=await getProjectAiConversation(projectId,conversationId);if(!conversation)return undefined
  return db.transaction(async tx=>{
    await tx.execute(sql`select ${aiConversations.id} from ${aiConversations} where ${aiConversations.id}=${conversationId} and ${aiConversations.projectId}=${projectId} for update`)
    const [sequenceRow]=await tx.select({value:max(aiMessages.sequence)}).from(aiMessages).where(eq(aiMessages.conversationId,conversationId))
    const [message]=await tx.insert(aiMessages).values({conversationId,role:'assistant',status:'completed',content:normalizeContent(input.content),sequence:(sequenceRow?.value??0)+1,metadata:input.metadata??{}}).returning()
    const citations=input.citations.length?await tx.insert(aiCitations).values(input.citations.map((citation,index)=>citationValues(message.id,citation,index))).returning():[]
    await tx.update(aiConversations).set({updatedAt:new Date(),...(input.lastEventSeq===undefined?{}:{lastEventSeq:input.lastEventSeq})}).where(and(eq(aiConversations.id,conversationId),eq(aiConversations.projectId,projectId)))
    return{...message,citations}
  })
}

export async function createFailedProjectAiAnswer(projectId:string,conversationId:string,content:string,errorCode:string,metadata:Record<string,unknown>={}){
  const message=await createProjectAiMessage(projectId,conversationId,{role:'assistant',content,status:'failed',metadata:{...metadata,errorCode}})
  if(message)await db.update(aiMessages).set({errorCode}).where(eq(aiMessages.id,message.id))
  return message?{...message,errorCode}:message
}

export async function markProjectAiMessageCompleted(projectId:string,conversationId:string,messageId:string){const conversation=await getProjectAiConversation(projectId,conversationId);if(!conversation)return undefined;const [row]=await db.update(aiMessages).set({status:'completed',updatedAt:new Date()}).where(and(eq(aiMessages.id,messageId),eq(aiMessages.conversationId,conversationId))).returning();return row}

export async function bindHarnessSession(projectId: string, conversationId: string, session: { sessionId: string }, selection: { provider?: string; model?: string }) {
  const [row] = await db.update(aiConversations).set({ harnessSessionId: session.sessionId, provider: selection.provider, model: selection.model, updatedAt: new Date() }).where(and(eq(aiConversations.id, conversationId), eq(aiConversations.projectId, projectId))).returning()
  return row
}

function citationValues(messageId:string,citation:CitationCreate,sortOrder:number){return{messageId,sourceProjectId:citation.sourceProjectId,sourceProjectCode:citation.sourceProjectCode,documentId:citation.documentId,versionId:citation.versionId,versionNumber:citation.versionNumber,chunkId:citation.chunkId,chunkIndex:citation.chunkIndex,checksum:citation.checksum,capturedAt:new Date(citation.capturedAt),sortOrder,snippet:citation.snippet,pageNumber:citation.pageNumber,sectionPath:citation.sectionPath,score:citation.score}}

async function assertProject(projectId: string) { assertUuid(projectId, 'project_id_invalid'); const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1); if (!row) throw new Error('project_not_found') }
function assertUuid(value: string, code: string) { if (!UUID_PATTERN.test(value)) throw new Error(code) }
function assertBody(value: unknown): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ai_request_body_invalid') }
function normalizeTitle(value?: string) { const title = value?.trim() || '新对话'; if (title.length > 120 || /[\u0000-\u001f]/.test(title)) throw new Error('ai_conversation_title_invalid'); return title }
function normalizeContent(value?: string) { const content = value?.trim(); if (!content || content.length > 100_000) throw new Error('ai_message_content_invalid'); return content }
function parseLimit(value: string | undefined, fallback: number, maxValue: number) { const parsed = value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxValue) throw new Error('ai_limit_invalid'); return parsed }
function parseSequence(value: string) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('ai_message_cursor_invalid'); return parsed }
function parseDate(value: string, code: string) { const date = new Date(value); if (Number.isNaN(date.valueOf())) throw new Error(code); return date }

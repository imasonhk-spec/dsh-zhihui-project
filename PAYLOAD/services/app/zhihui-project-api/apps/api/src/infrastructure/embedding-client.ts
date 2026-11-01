import 'dotenv/config'
import { createHash } from 'node:crypto'
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from '../modules/knowledge/vector-store-service.ts'

export const EMBEDDING_PROVIDER = 'ollama'
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL?.trim() || 'bge-m3:latest'
const baseUrl = (process.env.EMBEDDING_BASE_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/$/, '')
const timeoutMs = Number(process.env.EMBEDDING_TIMEOUT_MS ?? 60_000)
const batchSize = Number(process.env.EMBEDDING_BATCH_SIZE ?? 16)

export async function embedTexts(texts: string[]) {
  if (!texts.length || texts.length > 64 || texts.some(text => !text.trim() || text.length > 20_000)) throw new Error('knowledge_embedding_input_invalid')
  const vectors: number[][] = []
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts.slice(offset, offset + batchSize), truncate: true }),
      })
      if (!response.ok) throw new Error('knowledge_embedding_provider_failed')
      const body = await response.json() as { embeddings?: unknown }
      if (!Array.isArray(body.embeddings)) throw new Error('knowledge_embedding_response_invalid')
      for (const vector of body.embeddings) vectors.push(validateVector(vector))
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('knowledge_')) throw error
      throw new Error(error instanceof Error && error.name === 'AbortError' ? 'knowledge_embedding_timeout' : 'knowledge_embedding_provider_failed')
    } finally { clearTimeout(timer) }
  }
  if (vectors.length !== texts.length) throw new Error('knowledge_embedding_response_invalid')
  return vectors
}

export async function checkEmbeddingProvider() {
  const [embedding] = await embedTexts(['项目知识库向量服务健康检查'])
  return { provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL, dimensions: embedding!.length, ok: true }
}

export function embeddingContentHash(value: string) { return createHash('sha256').update(value.normalize('NFKC').trim()).digest('hex') }
function validateVector(value: unknown) {
  if (!Array.isArray(value) || value.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS || value.some(item => typeof item !== 'number' || !Number.isFinite(item)) || value.every(item => item === 0)) throw new Error('knowledge_embedding_dimensions_invalid')
  return value as number[]
}

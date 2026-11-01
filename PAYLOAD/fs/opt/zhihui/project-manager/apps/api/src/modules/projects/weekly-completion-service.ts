import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { projects } from '../../db/schema.ts'
import type { DeepSeekHarnessClient } from '../../ai/deepseek-harness.ts'

export type WeeklyCompletionItem = { title: string; detail: string }
export type WeeklyCompletionSummary = { items: WeeklyCompletionItem[]; source: 'model' | 'rules'; sourceName?: string; importedAt?: string }

export async function getLatestWeeklyCompletion(projectId: string, harness?: DeepSeekHarnessClient): Promise<WeeklyCompletionSummary | undefined> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) return undefined
  const snapshot = project.metadata?.latestWeeklyCompletion
  if (!snapshot || typeof snapshot !== 'object' || typeof (snapshot as any).text !== 'string') return { items: [], source: 'rules' }
  const text = String((snapshot as any).text).trim()
  const fingerprint = createHash('sha256').update(`weekly-completion-v2\n${text}`).digest('hex')
  const fallback = splitCompletionText(text)
  const base = { sourceName: typeof (snapshot as any).sourceName === 'string' ? (snapshot as any).sourceName : undefined, importedAt: typeof (snapshot as any).importedAt === 'string' ? (snapshot as any).importedAt : undefined }
  const cachedItems = Array.isArray((snapshot as any).items) ? (snapshot as any).items.filter((item: any) => item && typeof item.title === 'string' && typeof item.detail === 'string') : []
  if ((snapshot as any).fingerprint === fingerprint && cachedItems.length) return { ...base, items: cachedItems, source: (snapshot as any).source === 'model' ? 'model' : 'rules' }
  if (!text) return { ...base, items: fallback, source: 'rules' }
  if (!harness) return await cacheAndReturn(project, snapshot as Record<string, unknown>, fingerprint, fallback, 'rules', base)
  let sessionId: string | undefined
  try {
    const session = await harness.createSession()
    sessionId = session.sessionId
    const prompt = `将以下“本周工作完成情况说明”按全部一级编号拆分并精炼为完成工作列表。严格要求：只使用原文事实，不推测、不新增数字；不得把多个一级编号合并；每项输出JSON对象，title不超过18字，detail不超过180字；只返回JSON数组，不要Markdown。\n原文：\n${text}`
    const result = await withTimeout(harness.promptAndWait(session.sessionId, prompt), 12_000)
    const parsed = parseItems(result.text)
    if (parsed.length) return await cacheAndReturn(project, snapshot as Record<string, unknown>, fingerprint, parsed, 'model', base)
  } catch { if (sessionId) await harness.cancel(sessionId).catch(() => undefined) }
  return await cacheAndReturn(project, snapshot as Record<string, unknown>, fingerprint, fallback, 'rules', base)
}

async function cacheAndReturn(project: typeof projects.$inferSelect, snapshot: Record<string, unknown>, fingerprint: string, items: WeeklyCompletionItem[], source: 'model' | 'rules', base: { sourceName?: string; importedAt?: string }): Promise<WeeklyCompletionSummary> {
  await db.update(projects).set({ metadata: { ...project.metadata, latestWeeklyCompletion: { ...snapshot, fingerprint, items, source } } }).where(eq(projects.id, project.id))
  return { ...base, items, source }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('weekly_completion_model_timeout')), timeoutMs) })]) }
  finally { if (timer) clearTimeout(timer) }
}

function splitCompletionText(text: string): WeeklyCompletionItem[] {
  const normalized = text.replace(/\r/g, '').trim()
  if (!normalized) return []
  const matches = [...normalized.matchAll(/(?:^|\n|\s)(\d+)[.、．]\s*([^：:\n]{2,30})[：:]?/g)]
  if (!matches.length) return [{ title: '本周完成工作', detail: normalized.slice(0, 500) }]
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].indexOf(match[2]!)
    const end = index + 1 < matches.length ? matches[index + 1]!.index ?? normalized.length : normalized.length
    const raw = normalized.slice(start, end).trim().replace(/[；;\s]+$/, '')
    const title = match[2]!.trim()
    const detail = raw.replace(new RegExp(`^${escapeRegExp(title)}[：:]?\\s*`), '').trim() || raw
    return { title, detail: detail.slice(0, 500) }
  })
}
function parseItems(value: string): WeeklyCompletionItem[] {
  try {
    const match = value.match(/\[[\s\S]*\]/)
    const rows = JSON.parse(match?.[0] ?? value)
    if (!Array.isArray(rows)) return []
    return rows.filter(item => item && typeof item.title === 'string' && typeof item.detail === 'string').map(item => ({ title: item.title.trim().slice(0, 30), detail: item.detail.trim().slice(0, 500) })).filter(item => item.title && item.detail)
  } catch { return [] }
}
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/**
 * 智汇统一登录认证 —— 应用侧守卫（自包含，跨仓库同文件复用）。
 *
 * 凭证两种：
 *  1. 浏览器会话 Cookie `zh_session`（门户登录 + 一次性票据换取）；
 *  2. 服务端调用令牌 `x-zh-service`（ZH_SERVICE_TOKEN，供本机服务间调用）。
 * 用户/会话/票据均存共享 Postgres（auth_users / auth_sessions / auth_tickets）。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { Pool } from 'pg'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export const SESSION_COOKIE = process.env.ZH_SESSION_COOKIE_NAME?.trim() || 'zh_session'
if (!/^[A-Za-z0-9_-]{1,64}$/.test(SESSION_COOKIE)) throw new Error('ZH_SESSION_COOKIE_NAME invalid')
// 会话策略：闲置 2 小时窗口（expires_at = 最后活动 + 2h，滑动续期）
// 或 24 小时绝对上限（created_at + 24h），先到先失效；五端统一。
const SESSION_IDLE_TTL_MS = 2 * 3600 * 1000
const SESSION_ABS_TTL_MS = 24 * 3600 * 1000
const TICKET_TTL_MS = 120 * 1000
const SERVICE_HEADER = 'x-zh-service'

export type AuthUser = { username: string; displayName: string | null }

export type AuthOptions = {
  /** 本应用标识：project | opportunity */
  appId: string
  /** 门户对外地址（供前端未登录跳转），如 http://192.168.8.103:3300 */
  portalUrl: string
  /** 服务端互信令牌；为空则不接受令牌通道 */
  serviceToken?: string
}

const authPool = new Pool({ connectionString: process.env.DATABASE_URL })

const DYNAMIC_PORTAL_HOSTS = new Set(['10.18.105.88', '10.18.23.15', '10.18.23.82', '10.18.23.73', '192.168.8.103', '192.168.8.102', '100.73.194.117', 'localhost', '127.0.0.1'])

function portalUrlForRequest(request: FastifyRequest, fallback: string): string {
  const rawHost = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0].trim()
  let hostname = ''
  try { hostname = new URL(`http://${rawHost}`).hostname } catch { /* use configured fallback */ }
  if (!DYNAMIC_PORTAL_HOSTS.has(hostname)) return fallback
  const protocol = String(request.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() === 'https' ? 'https' : 'http'
  return `${protocol}://${hostname}:3300`
}


export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  try {
    const expected = Buffer.from(hashHex, 'hex')
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
    return timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

async function findUser(username: string): Promise<{ id: string; passwordHash: string; displayName: string | null } | null> {
  const result = await authPool.query('SELECT id, password_hash, display_name FROM auth_users WHERE username = $1', [username])
  const row = result.rows[0] as { id: string; password_hash: string; display_name: string | null } | undefined
  return row ? { id: row.id, passwordHash: row.password_hash, displayName: row.display_name } : null
}

export async function getSessionUser(cookieHeader: string | undefined): Promise<(AuthUser & { sessionId: string }) | null> {
  const sessionId = parseCookies(cookieHeader)[SESSION_COOKIE]
  if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId)) return null
  const result = await authPool.query(
    `SELECT s.id, u.username, u.display_name, s.last_seen_at FROM auth_sessions s
     JOIN auth_users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()
       AND s.created_at > now() - interval '24 hours'`,
    [sessionId],
  )
  const row = result.rows[0] as { id: string; username: string; display_name: string | null; last_seen_at: Date } | undefined
  if (!row) return null
  if (Date.now() - row.last_seen_at.getTime() > 30 * 60 * 1000) {
    await authPool.query(
      'UPDATE auth_sessions SET last_seen_at = now(), expires_at = now() + $1::interval WHERE id = $2',
      [`${Math.round(SESSION_IDLE_TTL_MS / 1000)} seconds`, row.id],
    )
  }
  return { sessionId: row.id, username: row.username, displayName: row.display_name }
}

export async function createSession(userId: string, app: string): Promise<string> {
  const result = await authPool.query(
    `INSERT INTO auth_sessions (user_id, app, expires_at) VALUES ($1, $2, now() + $3::interval) RETURNING id`,
    [userId, app, `${Math.round(SESSION_IDLE_TTL_MS / 1000)} seconds`],
  )
  return (result.rows[0] as { id: string }).id
}

export async function destroySession(sessionId: string): Promise<void> {
  await authPool.query('DELETE FROM auth_sessions WHERE id = $1', [sessionId])
}

export async function consumeTicket(ticket: string, app: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ticket)) return false
  const result = await authPool.query(
    `UPDATE auth_tickets SET consumed_at = now()
     WHERE ticket = $1 AND app = $2 AND consumed_at IS NULL AND expires_at > now()
     RETURNING ticket`,
    [ticket, app],
  )
  return result.rowCount === 1
}

export function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(SESSION_ABS_TTL_MS / 1000)}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/** 未登录直连接口一律 401；放行 /health*、/api/auth/*、服务令牌。 */
export function registerAuthGuard(app: FastifyInstance, options: AuthOptions): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0]
    if (path === '/health' || path.startsWith('/health/')) return
    if (path.startsWith('/api/auth/')) return
    if (options.serviceToken && request.headers[SERVICE_HEADER] === options.serviceToken) return
    const user = await getSessionUser(request.headers.cookie)
    if (user) {
      ;(request as FastifyRequest & { authUser?: AuthUser }).authUser = { username: user.username, displayName: user.displayName }
      return
    }
    void reply.code(401).send({ error: 'AUTH_REQUIRED', portalUrl: portalUrlForRequest(request, options.portalUrl) })
  })

  app.get('/api/auth/me', async (request, reply) => {
    const user = await getSessionUser(request.headers.cookie)
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' })
    return { username: user.username, displayName: user.displayName, app: options.appId }
  })

  app.get('/api/auth/portal', async (request) => ({ portalUrl: portalUrlForRequest(request, options.portalUrl) }))

  app.post<{ Body: { ticket?: string } }>('/api/auth/ticket', async (request, reply) => {
    const ticket = String(request.body?.ticket ?? '')
    if (!ticket) return reply.code(400).send({ error: 'ticket_required' })
    const user = await getSessionUser(request.headers.cookie)
    if (user) return { ok: true, already: true }
    const verified = await consumeTicket(ticket, options.appId)
    if (!verified) return reply.code(401).send({ error: 'ticket_invalid' })
    const admin = await findUser('admin')
    if (!admin) return reply.code(500).send({ error: 'auth_user_missing' })
    const sessionId = await createSession(admin.id, options.appId)
    void reply.header('set-cookie', sessionCookie(sessionId))
    return { ok: true }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    if (sessionId) await destroySession(sessionId)
    void reply.header('set-cookie', clearSessionCookie())
    return { ok: true }
  })
}

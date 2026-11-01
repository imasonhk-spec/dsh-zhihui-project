export type ApiErrorDetails = {
  status: number
  code?: string
  payload?: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly payload?: unknown

  constructor(message: string, details: ApiErrorDetails) {
    super(message)
    this.name = 'ApiError'
    this.status = details.status
    this.code = details.code
    this.payload = details.payload
  }
}

export type ApiClientOptions = {
  baseUrl?: string
  timeoutMs?: number
}

export class ApiClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly getCache = new Map<string, { expiresAt: number; value: unknown }>()
  private readonly getInflight = new Map<string, Promise<unknown>>()

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') ?? ''
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  peek<T>(path: string): T | undefined {
    const cached = this.getCache.get(path)
    if (cached && cached.expiresAt > Date.now()) return cached.value as T
    if (!isPersistentDashboardPath(path)) return undefined
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(`pm:get-cache:${path}`) ?? 'null') as { expiresAt?:number;value?:T }|null
      if (stored?.expiresAt && stored.expiresAt > Date.now()) { this.getCache.set(path,{expiresAt:stored.expiresAt,value:stored.value}); return stored.value }
    } catch { /* ignore invalid browser cache */ }
    return undefined
  }

  get<T>(path: string, init?: RequestInit) {
    if (init?.signal || init?.headers || !isPrefetchableProjectPath(path)) return this.request<T>(path, { ...init, method: 'GET' })
    const cached = this.getCache.get(path)
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value as T)
    const pending = this.getInflight.get(path)
    if (pending) return pending as Promise<T>
    const request = this.request<T>(path, { ...init, method: 'GET' }).then(value => {
      const entry = { expiresAt: Date.now() + 5 * 60_000, value }
      this.getCache.set(path, entry)
      if (isPersistentDashboardPath(path)) { try { window.sessionStorage.setItem(`pm:get-cache:${path}`, JSON.stringify(entry)) } catch { /* storage unavailable */ } }
      return value
    }).finally(() => this.getInflight.delete(path))
    this.getInflight.set(path, request)
    return request
  }

  post<T>(path: string, body?: unknown, init?: RequestInit) {
    return this.request<T>(path, {
      ...init,
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  patch<T>(path: string, body?: unknown, init?: RequestInit) {
    return this.request<T>(path, {
      ...init,
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  delete<T = void>(path: string, init?: RequestInit) {
    return this.request<T>(path, { ...init, method: 'DELETE' })
  }

  postForm<T>(path: string, body: FormData, init?: RequestInit) {
    return this.request<T>(path, { ...init, method: 'POST', body }, 5 * 60_000)
  }

  download(path: string, init?: RequestInit) {
    return this.downloadBlob(path, { ...init, method: init?.method ?? 'GET' })
  }

  postDownload(path: string, body?: unknown, init?: RequestInit) {
    return this.downloadBlob(path, {
      ...init,
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  private async downloadBlob(path: string, init: RequestInit) {
    const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 5 * 60_000)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document, application/octet-stream',
          ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      })
      if (!response.ok) { const payload = await parsePayload(response); const error = asErrorPayload(payload); throw new ApiError(error.message ?? `下载失败（HTTP ${response.status}）`, { status: response.status, code: error.code, payload }) }
      return { blob: await response.blob(), fileName: parseDownloadName(response.headers.get('content-disposition')) }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(error instanceof DOMException && error.name === 'AbortError' ? '下载请求超时' : '下载失败，请检查网络连接', { status: 0, payload: error })
    } finally { window.clearTimeout(timeout) }
  }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if ((init.method ?? 'GET') !== 'GET') {
      this.getCache.clear()
      try { for (let index=window.sessionStorage.length-1;index>=0;index--){const key=window.sessionStorage.key(index);if(key?.startsWith('pm:get-cache:'))window.sessionStorage.removeItem(key)} } catch { /* storage unavailable */ }
    }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      })
      const payload = await parsePayload(response)
      if (!response.ok) {
        const error = asErrorPayload(payload)
        throw new ApiError(error.message ?? `请求失败（HTTP ${response.status}）`, {
          status: response.status,
          code: error.code,
          payload,
        })
      }
      return payload as T
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('请求超时，请稍后重试', { status: 0, code: 'request_timeout' })
      }
      throw new ApiError('网络连接失败，请检查服务状态', {
        status: 0,
        code: 'network_error',
        payload: error,
      })
    } finally {
      window.clearTimeout(timeout)
    }
  }
}

function isPersistentDashboardPath(path:string){return path==='/api/projects/summary'||path==='/api/delivery-meeting-todos/dashboard'}

function isPrefetchableProjectPath(path: string) {
  if (path === '/api/projects/summary' || path.startsWith('/api/delivery-meeting-todos/dashboard')) return true
  return /^\/api\/projects\/[^/]+\/(?:overview|health-summary|approvals|imports|tasks|milestones|risks|coordination|knowledge|ai\/conversations)(?:\?|$)/.test(path)
    && !path.includes('/change-analysis')
    && !/\/ai\/conversations\/[^?]/.test(path)
}

async function parsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return response.json()
  const text = await response.text()
  return text || undefined
}

function asErrorPayload(payload: unknown): { code?: string; message?: string } {
  if (!payload || typeof payload !== 'object') return {}
  const value = payload as Record<string, unknown>
  return {
    code: typeof value.code === 'string' ? value.code : typeof value.error === 'string' ? value.error : undefined,
    message: typeof value.message === 'string' ? value.message : undefined,
  }
}

function parseDownloadName(header: string | null) {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) { try { return decodeURIComponent(encoded) } catch { /* fall through */ } }
  return header?.match(/filename="([^"]+)"/i)?.[1] ?? 'download'
}

export const apiClient = new ApiClient({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? '' })

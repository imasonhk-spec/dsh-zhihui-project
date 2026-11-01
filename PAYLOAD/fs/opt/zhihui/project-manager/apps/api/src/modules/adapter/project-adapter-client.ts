import { projectAdapterContract } from './project-adapter.ts'

export type AdapterClientOptions = { baseUrl: string; serviceToken: string; timeoutMs?: number; fetcher?: typeof fetch }
export class ProjectAdapterError extends Error { constructor(public code: string, public status?: number) { super(code); this.name = 'ProjectAdapterError' } }
const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
export function createProjectAdapterClient(options: AdapterClientOptions) {
  if (!options.baseUrl || !options.serviceToken) throw new ProjectAdapterError('adapter_configuration_invalid')
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? 8000
  async function request(path: string, init: RequestInit = {}) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(`${options.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers: { ...(init.headers ?? {}), 'x-zh-service': options.serviceToken, accept: 'application/json' }, signal: controller.signal })
      if (!response.ok) throw new ProjectAdapterError(response.status === 401 || response.status === 403 ? 'adapter_unauthorized' : response.status === 404 ? 'adapter_not_found' : 'adapter_upstream_failed', response.status)
      return await response.json()
    } catch (error) { if (error instanceof ProjectAdapterError) throw error; if (error instanceof Error && error.name === 'AbortError') throw new ProjectAdapterError('adapter_timeout'); throw new ProjectAdapterError('adapter_network_error') } finally { clearTimeout(timer) }
  }
  return {
    contract: projectAdapterContract,
    searchKnowledge: (projectId: string, query: string) => { if (!validId(projectId) || !query.trim()) throw new ProjectAdapterError('adapter_parameters_invalid'); return request(`/api/projects/${encodeURIComponent(projectId)}/knowledge/search?q=${encodeURIComponent(query)}`) },
    listConversations: (projectId: string) => { if (!validId(projectId)) throw new ProjectAdapterError('adapter_parameters_invalid'); return request(`/api/projects/${encodeURIComponent(projectId)}/ai/conversations`) },
  }
}

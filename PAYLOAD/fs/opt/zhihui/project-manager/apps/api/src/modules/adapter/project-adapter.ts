/** Read-only Project Adapter contract for AgentMM integration.
 * Gateway wiring is intentionally absent until its contract is frozen.
 */
export type ProjectAdapterFieldMap = {
  project: { id: string; code: string; name: string; status?: string; progress?: number }
  workspace: { projectId: string; knowledgeBaseId: string; folders: Array<{ id: string; path: string; parentId: string | null }> }
  acl: { principal: string; action: 'read'; resource: string }
  ai: { conversationId: string; messageId?: string; content?: string; status?: string; citations?: string[] }
}

export const projectAdapterContract = Object.freeze({
  version: '0.1', mode: 'read-only', productionGateway: false,
  endpoints: { projects: 'GET /api/projects', workspace: 'GET /api/projects/:projectId/knowledge', ai: 'GET/POST /api/projects/:projectId/ai/*', stream: 'GET /api/projects/:projectId/ai/conversations/:conversationId/stream', health: 'GET /health/dependencies' },
  auth: { cookie: 'zh_session', serviceHeader: 'x-zh-service', appId: 'project' },
  objectStorage: { keyPrefix: 'projects/{projectId}/knowledge/{documentId}/versions/{versionId}', maxBytesEnv: 'S3_MAX_OBJECT_BYTES' },
  acl: { boundary: 'projectId', defaultAction: 'read', denyCrossProject: true },
})

export function mapProjectAdapterFields(input: { project: Record<string, unknown>; workspace?: { knowledgeBaseId: string; folders: Array<{ id: string; path: string; parentId?: string | null }> }; ai?: Record<string, unknown> }) {
  return {
    project: { id: String(input.project.id), code: String(input.project.code), name: String(input.project.name), status: input.project.status as string | undefined, progress: input.project.progress as number | undefined },
    workspace: input.workspace ? { projectId: String(input.project.id), knowledgeBaseId: input.workspace.knowledgeBaseId, folders: input.workspace.folders.map(folder => ({ id: folder.id, path: folder.path, parentId: folder.parentId ?? null })) } : undefined,
    ai: input.ai ? { conversationId: String(input.ai.conversationId), messageId: input.ai.messageId as string | undefined, content: input.ai.content as string | undefined, status: input.ai.status as string | undefined, citations: Array.isArray(input.ai.citations) ? input.ai.citations.map(String) : undefined } : undefined,
  }
}

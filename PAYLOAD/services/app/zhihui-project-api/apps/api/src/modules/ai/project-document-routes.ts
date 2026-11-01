import type { FastifyInstance } from 'fastify'
import { generateProjectDocument } from './project-document-service.ts'
import { getProjectDocumentTemplate, type ProjectDocumentType } from './document-template-registry.ts'

export type ProjectDocumentRouteDependencies = {
  generate?: typeof generateProjectDocument
}

export function registerProjectDocumentRoutes(app: FastifyInstance, dependencies: ProjectDocumentRouteDependencies = {}) {
  const generate = dependencies.generate ?? generateProjectDocument
  app.post<{ Params: { projectId: string }; Body: { docType?: unknown } }>('/api/projects/:projectId/ai/documents/generate', async (request, reply) => {
    try {
      const template = getProjectDocumentTemplate(request.body?.docType)
      const result = await generate(request.params.projectId, template.docType as ProjectDocumentType)
      const safe = result.fileName.replace(/[^\x20-\x7E]|[\r\n"\\]/g, '_') || 'project-document.docx'
      const encoded = encodeURIComponent(result.fileName).replace(/'/g, '%27')
      return reply
        .header('Content-Type', result.mimeType)
        .header('Content-Disposition', `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`)
        .header('Content-Length', String(result.body.length))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .header('X-Archive-Document-Id', result.archiveDocumentId)
        .header('X-Template-Id', `${result.templateId}@${result.templateVersion}`)
        .send(result.body)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'ai_document_generate_failed'
      const status = code === 'project_not_found' ? 404 : code === 'ai_document_type_invalid' ? 400 : 503
      if (status >= 500) request.log.error({ error }, 'ai document generation failed')
      return reply.code(status).send({ error: status >= 500 ? 'ai_document_generate_failed' : code })
    }
  })
}

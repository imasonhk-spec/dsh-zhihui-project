import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { DOCX_MIME } from './project-document-service.ts'
import { registerProjectDocumentRoutes } from './project-document-routes.ts'

const projectId = '11111111-1111-4111-8111-111111111111'

test('generation route returns DOCX MIME, filename and bytes', async () => {
  const app = Fastify()
  registerProjectDocumentRoutes(app, { generate: async (_projectId, docType) => ({
    body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    fileName: `项目-${docType}.docx`,
    mimeType: DOCX_MIME,
    archiveDocumentId: 'archive-id',
    templateId: 'PM-DOC-PWR',
    templateVersion: '1.0.0',
  }) })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/ai/documents/generate`, payload: { docType: 'project_weekly_report' } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], DOCX_MIME)
  assert.match(response.headers['content-disposition'] ?? '', /\.docx/)
  assert.equal(response.headers['x-archive-document-id'], 'archive-id')
  assert.deepEqual([...response.rawPayload], [0x50, 0x4b, 0x03, 0x04])
  await app.close()
})

test('generation route rejects unknown document type', async () => {
  const app = Fastify()
  registerProjectDocumentRoutes(app, { generate: async () => { throw new Error('must_not_run') } })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/ai/documents/generate`, payload: { docType: 'unknown' } })
  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), { error: 'ai_document_type_invalid' })
  await app.close()
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'

const root = process.cwd()
process.env.TESSERACT_PATH ||= join(root, '.runtime/ocr/bin/tesseract')
process.env.PDFTOPPM_PATH ||= join(root, '.runtime/ocr/bin/pdftoppm')
process.env.PDFINFO_PATH ||= join(root, '.runtime/ocr/bin/pdfinfo')
process.env.TESSDATA_PREFIX ||= join(root, '.runtime/ocr/tessdata')

const { db, pool } = await import('../apps/api/src/db/client.ts')
const { documents, documentVersions, knowledgeBases, projects } = await import('../apps/api/src/db/schema.ts')
const { buildKnowledgeObjectKey, checksumSha256, deleteKnowledgeObject, putKnowledgeObject } = await import('../apps/api/src/infrastructure/object-storage.ts')
const { listProjectDocumentVersionChunks, parseProjectKnowledgeDocumentVersion } = await import('../apps/api/src/modules/knowledge/document-processing-service.ts')

const projectId = randomUUID(), baseId = randomUUID(), documentId = randomUUID(), versionId = randomUUID()
const directory = await mkdtemp(join(tmpdir(), 'pm-ocr-processing-'))
const imagePath = join(directory, 'fixture.png')
await run('/nix/store/1fj0wg21ba24hv612yg4kqwzxbnyappm-imagemagick-7.1.2-29/bin/convert', ['-size', '1800x600', 'xc:white', '-font', '/nix/store/b5gf37jp4y3965bp6x9wanzqchkkvbvs-dejavu-fonts-2.37/share/fonts/truetype/DejaVuSans.ttf', '-pointsize', '96', '-fill', 'black', '-gravity', 'center', '-annotate', '+0+0', 'Knowledge OCR Processing', imagePath])
const body = await readFile(imagePath), storageKey = buildKnowledgeObjectKey(projectId, documentId, versionId)
try {
  await db.insert(projects).values({ id: projectId, code: `OCR-${projectId.slice(0, 8)}`, name: 'OCR验收项目' })
  await db.insert(knowledgeBases).values({ id: baseId, projectId, name: 'OCR验收知识库' })
  await db.insert(documents).values({ id: documentId, projectId, knowledgeBaseId: baseId, name: 'OCR验收图片', originalName: 'ocr.png', fileType: 'png', mimeType: 'image/png', fileSize: body.length, checksum: checksumSha256(body), storageKey, version: 'v1', status: 'confirmed', parseStatus: 'pending', indexStatus: 'pending', aiEnabled: false })
  await db.insert(documentVersions).values({ id: versionId, documentId, versionNumber: 'v1', storageKey, checksum: checksumSha256(body), fileSize: body.length, mimeType: 'image/png', originalName: 'ocr.png', isCurrent: true })
  await putKnowledgeObject({ key: storageKey, body, contentType: 'image/png', contentLength: body.length })
  const result = await parseProjectKnowledgeDocumentVersion(projectId, documentId, versionId)
  assert.equal(result?.parser, 'tesseract')
  const chunks = await listProjectDocumentVersionChunks(projectId, documentId, versionId)
  assert.equal(chunks?.length, 1)
  assert.match((chunks?.[0]?.content ?? '').toLowerCase(), /knowledge ocr processing/)
  assert.equal(chunks?.[0]?.metadata.extractionMethod, 'ocr')
  assert.equal(typeof chunks?.[0]?.metadata.ocrConfidence, 'number')
  const [document] = await db.select({ parseStatus: documents.parseStatus, indexStatus: documents.indexStatus, aiEnabled: documents.aiEnabled, metadata: documents.metadata }).from(documents).where(eq(documents.id, documentId))
  assert.equal(document?.parseStatus, 'completed'); assert.equal(document?.indexStatus, 'pending'); assert.equal(document?.aiEnabled, false)
  const summary = document?.metadata.parseSummary as Record<string, unknown>
  assert.equal(summary.ocrPages, 1)
  console.log(JSON.stringify({ ok: true, persistedOcrChunks: 1, parser: result?.parser, ocrPages: summary.ocrPages, confidence: summary.meanOcrConfidence }))
} finally {
  await deleteKnowledgeObject(storageKey).catch(() => undefined)
  await db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined)
  await pool.end(); await rm(directory, { recursive: true, force: true })
}
function run(command: string, args: string[]) { return new Promise<void>((resolve, reject) => { const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }); const errors: Buffer[] = []; child.stderr.on('data', chunk => errors.push(Buffer.from(chunk))); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString()))) }) }

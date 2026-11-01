import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const root = process.cwd()
process.env.TESSERACT_PATH ||= join(root, '.runtime/ocr/bin/tesseract')
process.env.PDFTOPPM_PATH ||= join(root, '.runtime/ocr/bin/pdftoppm')
process.env.PDFINFO_PATH ||= join(root, '.runtime/ocr/bin/pdfinfo')
process.env.TESSDATA_PREFIX ||= join(root, '.runtime/ocr/tessdata')

const { recognizeImage, recognizeScannedPdf } = await import('../apps/api/src/modules/knowledge/ocr-service.ts')
const directory = await mkdtemp(join(tmpdir(), 'pm-ocr-smoke-'))
try {
  const pngPath = join(directory, 'fixture.png'), jpgPath = join(directory, 'fixture.jpg'), pdfPath = join(directory, 'fixture.pdf')
  const convert = '/nix/store/1fj0wg21ba24hv612yg4kqwzxbnyappm-imagemagick-7.1.2-29/bin/convert'
  await run(convert, ['-size', '1800x600', 'xc:white', '-font', '/nix/store/b5gf37jp4y3965bp6x9wanzqchkkvbvs-dejavu-fonts-2.37/share/fonts/truetype/DejaVuSans.ttf', '-pointsize', '96', '-fill', 'black', '-gravity', 'center', '-annotate', '+0+0', 'Project OCR 103 Acceptance', pngPath])
  await run(convert, [pngPath, '-quality', '94', jpgPath])
  await run(convert, [pngPath, pdfPath])

  const png = await recognizeImage(await readFile(pngPath), 'png')
  assert.match(normalize(png.pages[0]?.text), /projectocr103acceptance/)
  assert.equal(png.pages[0]?.metadata.extractionMethod, 'ocr')
  assert.equal(typeof png.pages[0]?.confidence, 'number')

  const jpg = await recognizeImage(await readFile(jpgPath), 'jpg')
  assert.match(normalize(jpg.pages[0]?.text), /projectocr103acceptance/)

  const pdf = await recognizeScannedPdf(await readFile(pdfPath))
  assert.equal(pdf.pages.length, 1)
  assert.equal(pdf.pages[0]?.pageNumber, 1)
  assert.match(normalize(pdf.pages[0]?.text), /projectocr103acceptance/)

  let invalidRejected = false
  try { await recognizeImage(Buffer.from('not-an-image'), 'png') } catch (error) { invalidRejected = error instanceof Error && error.message === 'knowledge_ocr_image_invalid' }
  assert.equal(invalidRejected, true)

  console.log(JSON.stringify({ ok: true, formats: ['png', 'jpg', 'scanned-pdf'], languages: ['chi_sim', 'eng'], imageConfidence: png.meanConfidence, pdfPages: pdf.pages.length, invalidSignatureRejected: true }))
} finally { await rm(directory, { recursive: true, force: true }) }

function normalize(value = '') { return value.toLowerCase().replace(/[^a-z0-9]+/g, '') }
function run(command: string, args: string[]) { return new Promise<void>((resolve, reject) => { const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }); const errors: Buffer[] = []; child.stderr.on('data', chunk => errors.push(Buffer.from(chunk))); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString()))) }) }

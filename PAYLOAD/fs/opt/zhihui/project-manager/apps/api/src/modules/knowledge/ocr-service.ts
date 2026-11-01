import 'dotenv/config'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'

export const OCR_SUPPORTED_TYPES = new Set(['png', 'jpg', 'jpeg'])
export const OCR_LIMITS = {
  maxImagePixels: Number(process.env.KNOWLEDGE_OCR_MAX_IMAGE_PIXELS ?? 25_000_000),
  maxPages: Number(process.env.KNOWLEDGE_OCR_MAX_PAGES ?? 50),
  pageTimeoutMs: Number(process.env.KNOWLEDGE_OCR_PAGE_TIMEOUT_MS ?? 60_000),
  documentTimeoutMs: Number(process.env.KNOWLEDGE_OCR_DOCUMENT_TIMEOUT_MS ?? 600_000),
  pdfDpi: Number(process.env.KNOWLEDGE_OCR_PDF_DPI ?? 250),
  lowConfidence: Number(process.env.KNOWLEDGE_OCR_LOW_CONFIDENCE ?? 70),
}

export type OcrPage = { text: string; pageNumber: number; confidence: number | null; metadata: Record<string, unknown> }
export type OcrResult = { parser: 'tesseract'; pages: OcrPage[]; warnings: string[]; meanConfidence: number | null; elapsedMs: number }

export async function recognizeImage(body: Buffer, fileType: string): Promise<OcrResult> {
  assertImageSignature(body, fileType)
  const dimensions = imageDimensions(body, fileType)
  assertImageLimit(dimensions.width, dimensions.height)
  const startedAt = Date.now()
  const page = await withTempDirectory(async directory => {
    const extension = fileType === 'jpeg' ? 'jpg' : fileType
    const path = join(directory, `source.${extension}`)
    await writeFile(path, body)
    return recognizeFile(path, 1, dimensions, OCR_LIMITS.pageTimeoutMs)
  })
  return summarize([page], startedAt)
}

export async function recognizeScannedPdf(body: Buffer): Promise<OcrResult> {
  const startedAt = Date.now()
  return withTempDirectory(async directory => {
    const source = join(directory, 'source.pdf'), outputPrefix = join(directory, 'page')
    await writeFile(source, body)
    const info = await inspectPdf(source)
    if (info.pages < 1 || info.pages > OCR_LIMITS.maxPages) throw new Error('knowledge_ocr_page_limit_exceeded')
    await run(resolveBinary('PDFTOPPM_PATH', 'pdftoppm'), ['-png', '-r', String(OCR_LIMITS.pdfDpi), '-f', '1', '-l', String(info.pages), source, outputPrefix], OCR_LIMITS.documentTimeoutMs, 'knowledge_ocr_pdf_render_failed')
    const pages: OcrPage[] = []
    for (let pageNumber = 1; pageNumber <= info.pages; pageNumber++) {
      if (Date.now() - startedAt > OCR_LIMITS.documentTimeoutMs) throw new Error('knowledge_ocr_document_timeout')
      const pagePath = join(directory, `page-${pageNumber}.png`)
      const pageBody = await readFile(pagePath).catch(() => { throw new Error('knowledge_ocr_pdf_render_failed') })
      const dimensions = imageDimensions(pageBody, 'png')
      assertImageLimit(dimensions.width, dimensions.height)
      pages.push(await recognizeFile(pagePath, pageNumber, dimensions, OCR_LIMITS.pageTimeoutMs))
      await rm(pagePath, { force: true })
    }
    return summarize(pages, startedAt)
  })
}

async function recognizeFile(path: string, pageNumber: number, dimensions: { width: number; height: number }, timeoutMs: number): Promise<OcrPage> {
  const directory = await mkdtemp(join(tmpdir(), 'pm-tessdata-'))
  try {
    const tessdata = await prepareTessdata(directory)
    const outputBase = join(directory, 'result')
    const startedAt = Date.now()
    await run(resolveBinary('TESSERACT_PATH', 'tesseract'), [path, outputBase, '-l', tessdata.languages.join('+'), '--tessdata-dir', tessdata.directory, '--dpi', String(OCR_LIMITS.pdfDpi), '-c', 'tessedit_create_tsv=1'], timeoutMs, 'knowledge_ocr_timeout')
    const tsv = await readFile(`${outputBase}.tsv`, 'utf8').catch(() => { throw new Error('knowledge_ocr_failed') })
    const parsed = parseTsv(tsv)
    if (!parsed.text) throw new Error('knowledge_ocr_no_text')
    return {
      text: parsed.text,
      pageNumber,
      confidence: parsed.confidence,
      metadata: {
        extractionMethod: 'ocr', ocrEngine: 'tesseract', ocrLanguages: tessdata.languages, ocrConfidence: parsed.confidence,
        ocrWordCount: parsed.wordCount, ocrLowConfidenceWordRatio: parsed.lowConfidenceRatio, imageWidth: dimensions.width,
        imageHeight: dimensions.height, ocrDpi: OCR_LIMITS.pdfDpi, elapsedMs: Date.now() - startedAt,
        needsReview: parsed.confidence !== null && parsed.confidence < OCR_LIMITS.lowConfidence,
      },
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function parseTsv(value: string) {
  const lines = value.split(/\r?\n/).slice(1); const words: Array<{ text: string; confidence: number }> = []
  for (const line of lines) {
    if (!line) continue
    const columns = line.split('\t'); const text = columns.slice(11).join('\t').trim(), confidence = Number(columns[10])
    if (text && Number.isFinite(confidence) && confidence >= 0) words.push({ text, confidence })
  }
  const confidence = words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : null
  const low = words.filter(word => word.confidence < OCR_LIMITS.lowConfidence).length
  return { text: words.map(word => word.text).join(' ').replace(/\s+/g, ' ').trim(), confidence, wordCount: words.length, lowConfidenceRatio: words.length ? low / words.length : 0 }
}

async function prepareTessdata(directory: string) {
  const configured = process.env.TESSDATA_PREFIX?.trim()
  const english = process.env.KNOWLEDGE_OCR_ENG_DATA?.trim()
  const chinese = process.env.KNOWLEDGE_OCR_CHI_SIM_DATA?.trim()
  if (configured) return { directory: configured, languages: await availableLanguages(configured) }
  if (!english) throw new Error('knowledge_ocr_language_data_missing')
  await symlink(english, join(directory, 'eng.traineddata'))
  const languages = ['eng']
  if (chinese) { await symlink(chinese, join(directory, 'chi_sim.traineddata')); languages.unshift('chi_sim') }
  return { directory, languages }
}
async function availableLanguages(directory: string) {
  const languages: string[] = []
  for (const language of ['chi_sim', 'eng']) if (await readFile(join(directory, `${language}.traineddata`)).then(() => true).catch(() => false)) languages.push(language)
  if (!languages.length) throw new Error('knowledge_ocr_language_data_missing')
  return languages
}
async function inspectPdf(path: string) {
  const output = await run(resolveBinary('PDFINFO_PATH', 'pdfinfo'), [path], 15_000, 'knowledge_ocr_pdf_invalid')
  const pages = Number(/^Pages:\s+(\d+)$/m.exec(output.stdout)?.[1])
  if (!Number.isSafeInteger(pages)) throw new Error('knowledge_ocr_pdf_invalid')
  return { pages }
}
function resolveBinary(envName: string, fallback: string) { return process.env[envName]?.trim() || fallback }
function summarize(pages: OcrPage[], startedAt: number): OcrResult {
  const confidences = pages.map(page => page.confidence).filter((value): value is number => value !== null)
  const warnings = pages.some(page => page.metadata.needsReview === true) ? ['ocr_low_confidence'] : []
  return { parser: 'tesseract', pages, warnings, meanConfidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null, elapsedMs: Date.now() - startedAt }
}
function assertImageLimit(width: number, height: number) { if (width < 1 || height < 1 || width * height > OCR_LIMITS.maxImagePixels) throw new Error('knowledge_ocr_image_limit_exceeded') }
function assertImageSignature(body: Buffer, type: string) {
  const png = body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), jpeg = body[0] === 0xff && body[1] === 0xd8 && body[body.length - 2] === 0xff && body[body.length - 1] === 0xd9
  if (type === 'png' ? !png : !jpeg) throw new Error('knowledge_ocr_image_invalid')
}
function imageDimensions(body: Buffer, type: string) {
  if (type === 'png') return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) }
  let offset = 2
  while (offset + 9 < body.length) {
    if (body[offset] !== 0xff) { offset++; continue }
    const marker = body[offset + 1]!, length = body.readUInt16BE(offset + 2)
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: body.readUInt16BE(offset + 5), width: body.readUInt16BE(offset + 7) }
    if (length < 2) break
    offset += length + 2
  }
  throw new Error('knowledge_ocr_image_invalid')
}
async function run(command: string, args: string[], timeoutMs: number, errorCode: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); const stdout: Buffer[] = [], stderr: Buffer[] = []; let settled = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); if (!settled) { settled = true; reject(new Error(errorCode)) } }, timeoutMs)
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk))); child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.once('error', () => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error(errorCode === 'knowledge_ocr_timeout' ? 'knowledge_ocr_engine_unavailable' : errorCode)) } })
    child.once('close', code => { clearTimeout(timer); if (settled) return; settled = true; code === 0 ? resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }) : reject(new Error(errorCode)) })
  })
}
async function withTempDirectory<T>(fn: (directory: string) => Promise<T>) { const directory = await mkdtemp(join(tmpdir(), 'pm-ocr-')); try { return await fn(directory) } finally { await rm(directory, { recursive: true, force: true }) } }

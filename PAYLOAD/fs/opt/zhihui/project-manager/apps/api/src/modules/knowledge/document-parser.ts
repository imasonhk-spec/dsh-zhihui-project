import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
import { parse as parseCsvRecords } from 'csv-parse/sync'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { SaxesParser } from 'saxes'
import yauzl from 'yauzl'
import { OCR_SUPPORTED_TYPES, recognizeImage, recognizeScannedPdf } from './ocr-service.ts'

export const SUPPORTED_PARSE_TYPES = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', ...OCR_SUPPORTED_TYPES])
export const PARSER_LIMITS = { maxPages: 500, maxTextChars: 5_000_000, maxChunks: 2_000, targetChars: 4_000, maxChars: 6_000, overlapChars: 400, maxRows: 100_000, maxSlides: 1_000 }

type SourceKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'txt' | 'md' | 'csv' | 'png' | 'jpg' | 'jpeg'
export type ParsedBlock = { text: string; title?: string | null; pageNumber?: number | null; sectionPath: string; metadata: Record<string, unknown> }
export type ParsedChunk = { chunkIndex: number; title: string | null; content: string; pageNumber: number | null; sectionPath: string; tokenCount: null; metadata: Record<string, unknown> }
export type ParsedDocument = { parser: string; sourceType: SourceKind; warnings: string[]; blocks: ParsedBlock[] }

export async function parseKnowledgeDocument(input: { body: Buffer; fileType: string; originalName: string }): Promise<ParsedDocument> {
  const type = input.fileType.trim().toLowerCase() as SourceKind
  if (!SUPPORTED_PARSE_TYPES.has(type)) throw new Error('knowledge_parse_type_unsupported')
  if (!input.body.length) throw new Error('knowledge_parse_file_empty')
  assertMagic(type, input.body)
  let parsed: ParsedDocument
  switch (type) {
    case 'pdf': parsed = await parsePdf(input.body); break
    case 'docx': parsed = await parseDocx(input.body); break
    case 'xlsx': parsed = await parseXlsx(input.body); break
    case 'pptx': parsed = await parsePptx(input.body); break
    case 'csv': parsed = parseCsv(input.body); break
    case 'md': parsed = parseMarkdown(input.body); break
    case 'png': case 'jpg': case 'jpeg': parsed = await parseImageOcr(input.body, type); break
    default: parsed = parseText(input.body)
  }
  const chars = parsed.blocks.reduce((total, block) => total + block.text.length, 0)
  if (!parsed.blocks.length || chars === 0) throw new Error(type === 'pdf' ? 'knowledge_parse_no_text_layer' : 'knowledge_parse_no_text')
  if (chars > PARSER_LIMITS.maxTextChars) throw new Error('knowledge_parse_text_limit_exceeded')
  return parsed
}

export function chunkParsedDocument(parsed: ParsedDocument, context: { originalName: string; checksum: string | null; documentId: string; versionId: string }): ParsedChunk[] {
  const chunks: ParsedChunk[] = []
  for (const block of parsed.blocks) {
    const text = normalizeText(block.text)
    if (!text) continue
    const pieces = splitWithOverlap(text, PARSER_LIMITS.targetChars, PARSER_LIMITS.maxChars, PARSER_LIMITS.overlapChars)
    for (const piece of pieces) {
      chunks.push({
        chunkIndex: chunks.length,
        title: block.title?.trim() || null,
        content: piece.text,
        pageNumber: block.pageNumber ?? null,
        sectionPath: block.sectionPath,
        tokenCount: null,
        metadata: {
          schemaVersion: 1,
          parser: parsed.parser,
          sourceType: parsed.sourceType,
          originalName: context.originalName,
          checksum: context.checksum,
          documentId: context.documentId,
          versionId: context.versionId,
          charStart: piece.start,
          charEnd: piece.end,
          warnings: parsed.warnings.slice(0, 20),
          ...block.metadata,
        },
      })
      if (chunks.length > PARSER_LIMITS.maxChunks) throw new Error('knowledge_parse_chunk_limit_exceeded')
    }
  }
  if (!chunks.length) throw new Error('knowledge_parse_no_text')
  return chunks
}

async function parsePdf(body: Buffer): Promise<ParsedDocument> {
  const task = getDocument({ data: new Uint8Array(body) })
  const pdf = await task.promise
  const blocks: ParsedBlock[] = []; let pageCount = 0
  try {
    pageCount = pdf.numPages
    if (pageCount > PARSER_LIMITS.maxPages) throw new Error('knowledge_parse_page_limit_exceeded')
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      if (content.items.length > 50_000) throw new Error('knowledge_parse_page_items_limit_exceeded')
      const lines: string[] = []; let line = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        const value = item.str.trim()
        if (value) line += `${line ? ' ' : ''}${value}`
        if ('hasEOL' in item && item.hasEOL && line) { lines.push(line); line = '' }
      }
      if (line) lines.push(line)
      const text = normalizeText(lines.join('\n'))
      if (text) blocks.push({ text, pageNumber, sectionPath: `page:${pageNumber}`, metadata: { pageNumber, extractionMethod: 'text-layer' } })
    }
  } finally { await pdf.destroy() }
  if (blocks.length === pageCount) return { parser: 'pdfjs-dist', sourceType: 'pdf', warnings: [], blocks }
  const nativePages = new Set(blocks.map(block => block.pageNumber))
  const ocr = await recognizeScannedPdf(body)
  for (const page of ocr.pages) if (!nativePages.has(page.pageNumber)) blocks.push({ text: page.text, pageNumber: page.pageNumber, sectionPath: `page:${page.pageNumber}`, metadata: page.metadata })
  blocks.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))
  return { parser: 'pdfjs-dist+tesseract', sourceType: 'pdf', warnings: ocr.warnings, blocks }
}

async function parseImageOcr(body: Buffer, type: 'png' | 'jpg' | 'jpeg'): Promise<ParsedDocument> {
  const ocr = await recognizeImage(body, type)
  return { parser: 'tesseract', sourceType: type, warnings: ocr.warnings, blocks: ocr.pages.map(page => ({ text: page.text, pageNumber: page.pageNumber, sectionPath: `image:${page.pageNumber}`, metadata: page.metadata })) }
}

async function parseDocx(body: Buffer): Promise<ParsedDocument> {
  const result = await mammoth.extractRawText({ buffer: body })
  const paragraphs = normalizeText(result.value).split(/\n{2,}/).map(value => value.trim()).filter(Boolean)
  return {
    parser: 'mammoth', sourceType: 'docx', warnings: result.messages.map(message => String(message.message).slice(0, 500)),
    blocks: paragraphs.map((text, index) => ({ text, sectionPath: `paragraph:${index + 1}`, metadata: { paragraphStart: index + 1, paragraphEnd: index + 1 } })),
  }
}

async function parseXlsx(body: Buffer): Promise<ParsedDocument> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(body as unknown as ExcelJS.Buffer)
  if (workbook.worksheets.length > 100) throw new Error('knowledge_parse_sheet_limit_exceeded')
  const blocks: ParsedBlock[] = []; let rowCount = 0
  for (const sheet of workbook.worksheets) {
    const rows: Array<{ number: number; text: string }> = []
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      rowCount++
      if (rowCount > PARSER_LIMITS.maxRows) throw new Error('knowledge_parse_row_limit_exceeded')
      const cells: string[] = []
      row.eachCell({ includeEmpty: true }, cell => cells.push(cellToText(cell.value)))
      const text = cells.join('\t').trimEnd()
      if (text.trim()) rows.push({ number: rowNumber, text })
    })
    for (let offset = 0; offset < rows.length; offset += 100) {
      const group = rows.slice(offset, offset + 100)
      if (!group.length) continue
      const start = group[0]!.number, end = group[group.length - 1]!.number
      blocks.push({ title: sheet.name, text: group.map(row => row.text).join('\n'), sectionPath: `sheet:${sheet.name}/rows:${start}-${end}`, metadata: { sheetName: sheet.name, rowStart: start, rowEnd: end } })
    }
  }
  return { parser: 'exceljs', sourceType: 'xlsx', warnings: [], blocks }
}

function parseCsv(body: Buffer): ParsedDocument {
  const text = decodeUtf8(body)
  const records = parseCsvRecords(text, { bom: true, columns: false, skip_empty_lines: false, relax_column_count: true, max_record_size: 1_048_576 }) as unknown[][]
  if (records.length > PARSER_LIMITS.maxRows) throw new Error('knowledge_parse_row_limit_exceeded')
  const blocks: ParsedBlock[] = []
  for (let offset = 0; offset < records.length; offset += 100) {
    const group = records.slice(offset, offset + 100)
    const content = group.map(row => row.map(value => String(value ?? '')).join('\t')).join('\n').trim()
    if (content) blocks.push({ text: content, sectionPath: `rows:${offset + 1}-${offset + group.length}`, metadata: { rowStart: offset + 1, rowEnd: offset + group.length } })
  }
  return { parser: 'csv-parse', sourceType: 'csv', warnings: [], blocks }
}

function parseText(body: Buffer): ParsedDocument {
  const text = decodeUtf8(body)
  const lines = text.split('\n'); const blocks: ParsedBlock[] = []
  for (let offset = 0; offset < lines.length; offset += 200) {
    const content = lines.slice(offset, offset + 200).join('\n').trim()
    if (content) blocks.push({ text: content, sectionPath: `lines:${offset + 1}-${Math.min(lines.length, offset + 200)}`, metadata: { lineStart: offset + 1, lineEnd: Math.min(lines.length, offset + 200) } })
  }
  return { parser: 'utf8-text', sourceType: 'txt', warnings: [], blocks }
}

function parseMarkdown(body: Buffer): ParsedDocument {
  const lines = decodeUtf8(body).split('\n'); const blocks: ParsedBlock[] = []; const headings: string[] = []; let start = 1; let buffer: string[] = []
  const flush = (end: number) => { const text = buffer.join('\n').trim(); if (text) blocks.push({ title: headings.at(-1) ?? null, text, sectionPath: headings.length ? headings.join(' / ') : `lines:${start}-${end}`, metadata: { headingPath: [...headings], lineStart: start, lineEnd: end } }); buffer = [] }
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match) { flush(index); const level = match[1]!.length; headings.splice(level - 1); headings[level - 1] = match[2]!; start = index + 1 }
    buffer.push(line)
  })
  flush(lines.length)
  return { parser: 'markdown-headings', sourceType: 'md', warnings: [], blocks }
}

async function parsePptx(body: Buffer): Promise<ParsedDocument> {
  const entries = await unzipSelected(body, name => /^ppt\/slides\/slide\d+\.xml$/.test(name) || name === 'ppt/presentation.xml' || name === 'ppt/_rels/presentation.xml.rels')
  const orderedNames = resolveSlideOrder(entries)
  const fallbackNames = [...entries.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(/slide(\d+)\.xml$/.exec(a)?.[1]) - Number(/slide(\d+)\.xml$/.exec(b)?.[1]))
  const slideNames = orderedNames.length ? orderedNames : fallbackNames
  if (slideNames.length > PARSER_LIMITS.maxSlides) throw new Error('knowledge_parse_slide_limit_exceeded')
  return { parser: 'yauzl+saxes', sourceType: 'pptx', warnings: orderedNames.length ? [] : ['presentation_order_unavailable'], blocks: slideNames.map((name, index) => ({ name, text: extractDrawingText(entries.get(name) ?? Buffer.alloc(0)), number: Number(/slide(\d+)\.xml$/.exec(name)?.[1]) })).filter(slide => slide.text).map((slide, index) => ({ text: slide.text, pageNumber: index + 1, sectionPath: `slide:${index + 1}`, metadata: { slideNumber: index + 1, sourceSlideFileNumber: slide.number } })) }
}

function resolveSlideOrder(entries: Map<string, Buffer>) {
  const presentation = entries.get('ppt/presentation.xml')?.toString('utf8')
  const relationships = entries.get('ppt/_rels/presentation.xml.rels')?.toString('utf8')
  if (!presentation || !relationships) return []
  const relationTargets = new Map<string, string>()
  const relationPattern = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?\s*>/g
  for (const match of relationships.matchAll(relationPattern)) {
    const target = match[2]!
    if (/slides\/slide\d+\.xml$/.test(target)) relationTargets.set(match[1]!, target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\//, '')}`)
  }
  const ids = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/?\s*>/g)].map(match => match[1]!)
  return ids.map(id => relationTargets.get(id)).filter((name): name is string => Boolean(name && entries.has(name)))
}

function extractDrawingText(xml: Buffer) {
  const parts: string[] = []; let text = ''; let inText = false
  const parser = new SaxesParser({ xmlns: false })
  parser.on('opentag', tag => { const name = String(tag.name); if (name.endsWith(':t') || name === 't') inText = true; if (name.endsWith(':br') || name === 'br') parts.push('\n') })
  parser.on('text', value => { if (inText) text += value })
  parser.on('closetag', tag => { const name = typeof tag === 'string' ? tag : tag.name; if (name.endsWith(':t') || name === 't') { if (text.trim()) parts.push(text.trim()); text = ''; inText = false } if (name.endsWith(':p') || name === 'p') parts.push('\n') })
  parser.write(xml.toString('utf8')).close()
  return normalizeText(parts.join(' '))
}

function unzipSelected(body: Buffer, include: (name: string) => boolean): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => yauzl.fromBuffer(body, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
    if (error || !zip) return reject(error ?? new Error('knowledge_parse_container_invalid'))
    const result = new Map<string, Buffer>(); let entries = 0; let total = 0
    zip.on('error', reject); zip.on('end', () => resolve(result)); zip.readEntry()
    zip.on('entry', entry => {
      entries++; if (entries > 5_000 || entry.uncompressedSize > 32 * 1024 * 1024 || total + entry.uncompressedSize > 256 * 1024 * 1024) { zip.close(); return reject(new Error('knowledge_parse_container_limit_exceeded')) }
      total += entry.uncompressedSize
      if (!include(entry.fileName)) { zip.readEntry(); return }
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) return reject(streamError ?? new Error('knowledge_parse_container_invalid'))
        const chunks: Buffer[] = []; stream.on('data', chunk => chunks.push(Buffer.from(chunk))); stream.on('error', reject); stream.on('end', () => { result.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry() })
      })
    })
  }))
}

function cellToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return String(value)
  if ('richText' in value) return value.richText.map(item => item.text).join('')
  if ('formula' in value) return value.result === undefined ? `=${value.formula}` : cellToText(value.result as ExcelJS.CellValue)
  if ('hyperlink' in value) return value.text || value.hyperlink
  if ('error' in value) return value.error
  return JSON.stringify(value)
}
function decodeUtf8(body: Buffer) { try { const text = new TextDecoder('utf-8', { fatal: true }).decode(body).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); if (text.includes('\u0000')) throw new Error(); return text } catch { throw new Error('knowledge_parse_encoding_invalid') } }
function normalizeText(value: string) { return value.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() }
function assertMagic(type: SourceKind, body: Buffer) { const zip = body[0] === 0x50 && body[1] === 0x4b; if (type === 'pdf' && body.subarray(0, 5).toString() !== '%PDF-') throw new Error('knowledge_parse_file_signature_invalid'); if (['docx', 'xlsx', 'pptx'].includes(type) && !zip) throw new Error('knowledge_parse_file_signature_invalid') }
function splitWithOverlap(text: string, target: number, max: number, overlap: number) {
  if (text.length <= max) return [{ text, start: 0, end: text.length }]
  const result: Array<{ text: string; start: number; end: number }> = []; let start = 0
  while (start < text.length) {
    let end = Math.min(start + target, text.length)
    if (end < text.length) { const windowEnd = Math.min(start + max, text.length); const candidates = [text.lastIndexOf('\n\n', windowEnd), text.lastIndexOf('\n', windowEnd), text.lastIndexOf('。', windowEnd), text.lastIndexOf('. ', windowEnd)].filter(value => value > start + Math.floor(target * 0.6)); end = candidates.length ? Math.max(...candidates) + 1 : windowEnd }
    const content = text.slice(start, end).trim(); if (content) result.push({ text: content, start, end })
    if (end >= text.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return result
}

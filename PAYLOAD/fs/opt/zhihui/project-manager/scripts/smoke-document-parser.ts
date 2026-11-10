import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'
import { parseKnowledgeDocument, chunkParsedDocument } from '../apps/api/src/modules/knowledge/document-parser.ts'

const context = { originalName: '验收文档', checksum: createHash('sha256').update('fixture').digest('hex'), documentId: '00000000-0000-0000-0000-000000000001', versionId: '00000000-0000-0000-0000-000000000002' }

const txt = await parseKnowledgeDocument({ body: Buffer.from('\uFEFF第一行\r\n第二行，包含中文。'), fileType: 'txt', originalName: 'test.txt' })
assert.equal(txt.sourceType, 'txt')
assert.match(txt.blocks[0]!.text, /第一行\n第二行/)

const md = await parseKnowledgeDocument({ body: Buffer.from('# 部署\n正文一\n\n## 回滚\n正文二'), fileType: 'md', originalName: 'test.md' })
assert.equal(md.blocks.length, 2)
assert.equal(md.blocks[1]!.sectionPath, '部署 / 回滚')

const csv = await parseKnowledgeDocument({ body: Buffer.from('\uFEFF名称,说明\r\n项目A,"包含,逗号"\r\n项目B,"包含\n换行"'), fileType: 'csv', originalName: 'test.csv' })
assert.match(csv.blocks[0]!.text, /包含,逗号/)
assert.match(csv.blocks[0]!.text, /包含\n换行/)

const workbook = new ExcelJS.Workbook()
const plan = workbook.addWorksheet('计划表')
plan.addRow(['任务', '日期'])
plan.addRow(['上线', new Date('2026-08-28T00:00:00.000Z')])
const xlsxBody = Buffer.from(await workbook.xlsx.writeBuffer())
const xlsx = await parseKnowledgeDocument({ body: xlsxBody, fileType: 'xlsx', originalName: 'test.xlsx' })
assert.equal(xlsx.blocks[0]!.sectionPath, 'sheet:计划表/rows:1-2')
assert.match(xlsx.blocks[0]!.text, /上线/)

const docxDocument = new Document({ sections: [{ children: [new Paragraph('项目文档第一段'), new Paragraph('项目文档第二段'), new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('表格内容')] })] })] })] }] })
const docxParsed = await parseKnowledgeDocument({ body: await Packer.toBuffer(docxDocument), fileType: 'docx', originalName: 'test.docx' })
assert.match(docxParsed.blocks.map(block => block.text).join('\n'), /项目文档第一段/)
assert.match(docxParsed.blocks.map(block => block.text).join('\n'), /表格内容/)

const pdfDocument = await PDFDocument.create()
const font = await pdfDocument.embedFont(StandardFonts.Helvetica)
pdfDocument.addPage().drawText('First page text layer', { x: 50, y: 700, font })
pdfDocument.addPage().drawText('Second page traceable', { x: 50, y: 700, font })
const pdf = await parseKnowledgeDocument({ body: Buffer.from(await pdfDocument.save()), fileType: 'pdf', originalName: 'test.pdf' })
assert.equal(pdf.blocks.length, 2)
assert.equal(pdf.blocks[1]!.pageNumber, 2)
assert.match(pdf.blocks[0]!.text, /First page/)

const pptxZip = new JSZip()
pptxZip.file('ppt/slides/slide2.xml', '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>')
pptxZip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>第一页</a:t></a:r><a:br/><a:r><a:t>项目说明</a:t></a:r></a:p></p:sld>')
const pptx = await parseKnowledgeDocument({ body: await pptxZip.generateAsync({ type: 'nodebuffer' }), fileType: 'pptx', originalName: 'test.pptx' })
assert.equal(pptx.blocks.length, 2)
assert.match(pptx.blocks[0]!.text, /第一页/)
assert.equal(pptx.blocks[1]!.pageNumber, 2)

const chunks = chunkParsedDocument({ parser: 'fixture', sourceType: 'txt', warnings: [], blocks: [{ text: `${'甲'.repeat(4_500)}\n\n${'乙'.repeat(4_500)}`, sectionPath: 'lines:1-2', metadata: { lineStart: 1, lineEnd: 2 } }] }, context)
assert.ok(chunks.length >= 2)
assert.deepEqual(chunks.map(chunk => chunk.chunkIndex), chunks.map((_, index) => index))
assert.ok(chunks.every(chunk => chunk.content.length <= 6_000 && chunk.metadata.documentId === context.documentId))

let oldOfficeRejected = false
try { await parseKnowledgeDocument({ body: Buffer.from('legacy'), fileType: 'doc', originalName: 'legacy.doc' }) } catch (error) { oldOfficeRejected = error instanceof Error && error.message === 'knowledge_parse_type_unsupported' }
assert.equal(oldOfficeRejected, true)

let invalidUtf8Rejected = false
try { await parseKnowledgeDocument({ body: Buffer.from([0xff, 0xfe, 0x00]), fileType: 'txt', originalName: 'invalid.txt' }) } catch (error) { invalidUtf8Rejected = error instanceof Error && error.message === 'knowledge_parse_encoding_invalid' }
assert.equal(invalidUtf8Rejected, true)

console.log(JSON.stringify({ ok: true, formats: ['pdf', 'docx', 'txt', 'md', 'csv', 'xlsx', 'pptx'], deterministicChunks: chunks.length, negativeCases: 2 }))

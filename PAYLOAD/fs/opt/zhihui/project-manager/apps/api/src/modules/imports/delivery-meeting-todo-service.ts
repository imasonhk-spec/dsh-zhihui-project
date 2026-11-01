import { createHash } from 'node:crypto'
import { and, asc, desc, eq, notLike } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import { db } from '../../db/client.ts'
import { deliveryMeetingTodoImports, deliveryMeetingTodos, projects } from '../../db/schema.ts'
import { createProjectProcessDocument } from '../knowledge/knowledge-service.ts'
import { parseAndIndexProjectDocument, type DocumentIndexResult } from '../knowledge/document-indexing-service.ts'

export type DeliveryMeetingTodoPreviewRow = {
  sourceRow: number; sequence?: number; establishedDate?: string; title: string; ownerName?: string; deadlineText?: string; dueDate?: string; projectNameRaw?: string; projectId?: string; matchedProjectName?: string; status: string; resultRemark?: string
}
export type DeliveryMeetingTodoPreview = { headers: string[]; rows: DeliveryMeetingTodoPreviewRow[]; errors: Array<{ row?: number; message: string }>; totalRows: number; matchedRows: number; unmatchedRows: number }

export async function previewDeliveryMeetingTodos(fileName: string, body: Buffer): Promise<DeliveryMeetingTodoPreview> {
  assertFile(fileName, body)
  const rows = await parseRows(body)
  const projectRows = await db.select({ id: projects.id, name: projects.name, shortName: projects.shortName, code: projects.code }).from(projects).where(notLike(projects.code, 'OPP-%')).orderBy(asc(projects.code))
  const errors: Array<{ row?: number; message: string }> = []
  const matched = rows.map(row => {
    const match = matchProject(row.projectNameRaw ?? '', projectRows)
    if (!row.title) errors.push({ row: row.sourceRow, message: 'meeting_todo_title_required' })
    if (match.ambiguous) errors.push({ row: row.sourceRow, message: `meeting_todo_project_ambiguous:${row.projectNameRaw}` })
    return { ...row, ...(match.project ? { projectId: match.project.id, matchedProjectName: match.project.name } : {}) }
  })
  return { headers: ['sequence','establishedDate','title','ownerName','deadlineText','projectNameRaw','matchedProjectName','status','resultRemark'], rows: matched, errors, totalRows: matched.length, matchedRows: matched.filter(row => row.projectId).length, unmatchedRows: matched.filter(row => !row.projectId).length }
}

export async function executeDeliveryMeetingTodos(fileName: string, body: Buffer) {
  const preview = await previewDeliveryMeetingTodos(fileName, body)
  if (preview.errors.some(error => error.message.startsWith('meeting_todo_title_required') || error.message.startsWith('meeting_todo_project_ambiguous'))) throw new Error('meeting_todo_preview_has_errors')
  const checksum = createHash('sha256').update(body).digest('hex')
  const imported = await db.transaction(async tx => {
    const [batch] = await tx.insert(deliveryMeetingTodoImports).values({ sourceName: fileName, checksum, totalRows: preview.totalRows, matchedRows: preview.matchedRows, unmatchedRows: preview.unmatchedRows }).returning()
    if (preview.rows.length) await tx.insert(deliveryMeetingTodos).values(preview.rows.map(row => ({ importId: batch.id, projectId: row.projectId ?? null, sourceRow: row.sourceRow, sequence: row.sequence ?? null, establishedDate: row.establishedDate ?? null, title: row.title, ownerName: row.ownerName ?? null, deadlineText: row.deadlineText ?? null, dueDate: row.dueDate ?? null, projectNameRaw: row.projectNameRaw ?? null, status: row.status, resultRemark: row.resultRemark ?? null })))
    return batch
  })
  const projectIds = [...new Set(preview.rows.map(row => row.projectId).filter((value): value is string => Boolean(value)))]
  const archiveErrors: Array<{ projectId: string; message: string }> = []
  const knowledge: Array<{ projectId: string } & DocumentIndexResult> = []
  for (const projectId of projectIds) {
    try {
      const document = await createProjectProcessDocument(projectId, 'delivery-meeting-todos', { fileName, body, fields: { status: 'confirmed', changeSummary: '项目交付中心周会待办事项导入归档' } })
      const indexed = await parseAndIndexProjectDocument(projectId, document.id)
      knowledge.push({ projectId, ...indexed })
    } catch (error) { archiveErrors.push({ projectId, message: error instanceof Error ? error.message : 'knowledge_archive_failed' }) }
  }
  const indexWarnings = knowledge.flatMap(item => item.warnings.map(warning => ({ projectId: item.projectId, ...warning })))
  return { ...imported, preview, archivedProjects: knowledge.length, archiveErrors, knowledge, indexWarnings }
}

export async function listDeliveryMeetingTodos(projectId?: string) {
  const [latest] = await db.select({ id: deliveryMeetingTodoImports.id, sourceName: deliveryMeetingTodoImports.sourceName, importedAt: deliveryMeetingTodoImports.importedAt }).from(deliveryMeetingTodoImports).orderBy(desc(deliveryMeetingTodoImports.importedAt), desc(deliveryMeetingTodoImports.id)).limit(1)
  if (!latest) return { batch: null, items: [] }
  const where = projectId ? and(eq(deliveryMeetingTodos.importId, latest.id), eq(deliveryMeetingTodos.projectId, projectId)) : eq(deliveryMeetingTodos.importId, latest.id)
  const items = await db.select().from(deliveryMeetingTodos).where(where).orderBy(asc(deliveryMeetingTodos.sourceRow))
  return { batch: latest, items }
}

async function parseRows(body: Buffer): Promise<DeliveryMeetingTodoPreviewRow[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(body as unknown as ExcelJS.Buffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('meeting_todo_sheet_not_found')
  let headerRow = 0
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 20); rowNumber += 1) {
    const texts = Array.from({ length: Math.min(sheet.columnCount, 12) }, (_, index) => sheet.getRow(rowNumber).getCell(index + 1).text.trim())
    if (texts.includes('待办事项') && texts.includes('所属项目')) { headerRow = rowNumber; break }
  }
  if (!headerRow) throw new Error('meeting_todo_header_not_found')
  const rows: DeliveryMeetingTodoPreviewRow[] = []
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const title = row.getCell(3).text.trim()
    if (!title && !row.getCell(6).text.trim()) continue
    const establishedDate = excelDate(row.getCell(2).value)
    const deadlineText = row.getCell(5).text.trim()
    rows.push({ sourceRow: rowNumber, sequence: integer(row.getCell(1).text), establishedDate, title, ownerName: optional(row.getCell(4).text), deadlineText: optional(deadlineText), dueDate: excelDate(row.getCell(5).value), projectNameRaw: optional(row.getCell(6).text), status: normalizeStatus(row.getCell(7).text), resultRemark: optional(row.getCell(8).text) })
  }
  return rows
}
function matchProject(raw: string, rows: Array<{ id: string; name: string; shortName: string | null; code: string }>) {
  const needle = normalizeName(raw)
  if (!needle) return {}
  const scored = rows.map(project => ({ project, score: Math.max(scoreName(needle, normalizeName(project.name)), scoreName(needle, normalizeName(project.shortName ?? '')), scoreName(needle, normalizeName(project.code))) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score)
  if (!scored.length) return {}
  if (scored[1] && scored[1].score === scored[0]!.score) return { ambiguous: true }
  return { project: scored[0]!.project }
}
function scoreName(a: string, b: string) { if (!a || !b) return 0; if (a === b) return 1000 + a.length; if (a.includes(b) || b.includes(a)) return 100 + Math.min(a.length, b.length); return 0 }
function normalizeName(value: string) { return value.toLowerCase().replace(/[\s·•“”"'（）()【】\[\]_-]/g, '').replace(/项目|建设|服务|智慧园区/g, '') }
function normalizeStatus(value: string) { const text = value.trim(); if (/未完成|未办结|待完成|未关闭/.test(text)) return 'pending'; if (/已完成|已经完成|已办结|^完成$|^办结$/.test(text)) return 'completed'; if (/暂停|挂起/.test(text)) return 'paused'; if (/进行中|推进中/.test(text)) return 'in_progress'; if (/取消|关闭/.test(text)) return 'closed'; return 'pending' }
function excelDate(value: ExcelJS.CellValue): string | undefined { if(value instanceof Date)return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;const text=typeof value==='string'?value.trim():'';const match=/^(\d{4})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?$/.exec(text);if(!match)return undefined;const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));return Number.isNaN(date.getTime())?undefined:date.toISOString().slice(0,10) }
function integer(value: string) { const number = Number.parseInt(value, 10); return Number.isFinite(number) ? number : undefined }
function optional(value: string) { const text = value.trim(); return text || undefined }
function assertFile(fileName: string, body: Buffer) { if (!/\.xlsx$/i.test(fileName)) throw new Error('meeting_todo_format_unsupported'); if (!body.length) throw new Error('import_file_required') }

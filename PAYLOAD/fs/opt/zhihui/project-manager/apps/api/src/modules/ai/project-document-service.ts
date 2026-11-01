import { inArray, sql } from 'drizzle-orm'
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'
import { db } from '../../db/client.ts'
import { documentChunks, documents, documentVersions, knowledgeFolders, projects } from '../../db/schema.ts'
import { authorizePortfolioKnowledge, type PortfolioAuthorization } from '../knowledge/knowledge-authorization.ts'
import { createProjectProcessDocument } from '../knowledge/knowledge-service.ts'
import { buildProjectContext, type ProjectContext, type ProjectContextFact } from './project-context-service.ts'
import { getProjectDocumentTemplate, type ProjectDocumentTemplate, type ProjectDocumentType } from './document-template-registry.ts'

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const BODY_FONT = '仿宋'
const HEADING_FONT = '黑体'
const MAX_KNOWLEDGE_FACTS = 20

type KnowledgeFact = { documentId: string; documentName: string; folderPath: string | null; sectionPath: string | null; content: string; sourceProjectId?: string; sourceProjectCode?: string; sourceProjectName?: string }
type PortfolioScope = { authorization: PortfolioAuthorization; projects: Array<{ id: string; code: string; name: string }> }
type DocumentSection = { title: string; paragraphs: string[] }
export type GeneratedProjectDocument = { body: Buffer; fileName: string; mimeType: typeof DOCX_MIME; archiveDocumentId: string; templateId: string; templateVersion: string }
export type ProjectDocumentDependencies = {
  context?: typeof buildProjectContext
  knowledge?: (projectId: string, portfolio: boolean, authorizedProjectIds?: string[]) => Promise<KnowledgeFact[]>
  portfolioScope?: (projectId: string) => Promise<PortfolioScope>
  archive?: typeof createProjectProcessDocument
  now?: () => Date
}

export async function generateProjectDocument(projectId: string, docType: ProjectDocumentType, deps: ProjectDocumentDependencies = {}): Promise<GeneratedProjectDocument> {
  const template = getProjectDocumentTemplate(docType)
  const context = await (deps.context ?? buildProjectContext)(projectId, 24_000)
  const portfolio = context.projectCode === 'OPP-MASTER' ? await (deps.portfolioScope ?? getPortfolioScope)(projectId) : undefined
  const knowledge = await (deps.knowledge ?? listDocumentKnowledgeFacts)(projectId, Boolean(portfolio), portfolio?.authorization.authorizedProjectIds)
  const generatedAt = (deps.now ?? (() => new Date()))()
  const sections = buildSections(template, context, knowledge, generatedAt, portfolio)
  const fileName = `${safeFilePart(context.projectName)}-${template.title}-${datePart(generatedAt)}.docx`
  const body = await renderDocx(template, context, knowledge, sections, generatedAt, portfolio)
  const archived = await (deps.archive ?? createProjectProcessDocument)(projectId, 'weekly-report', {
    fileName,
    mimeType: DOCX_MIME,
    body,
    fields: {
      name: fileName.replace(/\.docx$/i, ''),
      status: 'confirmed',
      changeSummary: `AI文档生成；模板=${template.templateId}@${template.version}；类型=${docType}`,
    },
  })
  return { body, fileName, mimeType: DOCX_MIME, archiveDocumentId: archived.id, templateId: template.templateId, templateVersion: template.version }
}

export async function getPortfolioScope(projectId: string): Promise<PortfolioScope> {
  const authorization = await authorizePortfolioKnowledge(projectId)
  const projectRows = await db.select({ id: projects.id, code: projects.code, name: projects.name }).from(projects).where(inArray(projects.id, authorization.authorizedProjectIds))
  const byId = new Map(projectRows.map(project => [project.id, project]))
  return { authorization, projects: authorization.authorizedProjectIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) }
}

export async function listDocumentKnowledgeFacts(projectId: string, portfolio: boolean, authorizedProjectIds?: string[]): Promise<KnowledgeFact[]> {
  if (portfolio && !authorizedProjectIds?.length) throw new Error('knowledge_portfolio_scope_empty')
  const scope = portfolio ? sql`d.project_id in (${sql.join(authorizedProjectIds!.map(id => sql`${id}::uuid`), sql`, `)})` : sql`d.project_id = ${projectId}::uuid`
  const rows = await db.execute<{ document_id: string; document_name: string; folder_path: string | null; section_path: string | null; content: string; source_project_id: string; source_project_code: string; source_project_name: string }>(sql`
    select d.id as document_id, d.name as document_name, kf.path as folder_path, dc.section_path, dc.content,
      p.id as source_project_id, p.code as source_project_code, p.name as source_project_name
    from document_chunks dc
    join documents d on d.id = dc.document_id
    join projects p on p.id = d.project_id
    join document_versions dv on dv.id = dc.version_id and dv.document_id = d.id
    left join knowledge_folders kf on kf.id = d.folder_id and kf.knowledge_base_id = d.knowledge_base_id
    where ${scope} and d.project_id is not null and dv.is_current = true and d.parse_status = 'completed'
      and d.status not in ('archived', 'obsolete')
    order by d.updated_at desc, dc.chunk_index asc
    limit ${MAX_KNOWLEDGE_FACTS}
  `)
  return rows.rows.map(row => ({ documentId: row.document_id, documentName: row.document_name, folderPath: row.folder_path, sectionPath: row.section_path, content: compact(row.content, 700), sourceProjectId: row.source_project_id, sourceProjectCode: row.source_project_code, sourceProjectName: row.source_project_name }))
}

function buildSections(template: ProjectDocumentTemplate, context: ProjectContext, knowledge: KnowledgeFact[], now: Date, portfolio?: PortfolioScope): DocumentSection[] {
  const observed = context.facts.filter(item => item.factType === 'observed')
  const plans = context.facts.filter(item => item.factType === 'plan')
  const by = (types: ProjectContextFact['sourceType'][], source = context.facts) => source.filter(item => types.includes(item.sourceType)).map(formatStructuredFact)
  const kb = knowledge.map(formatKnowledgeFact)
  const missing = (text: string) => [`待补：${text}`]
  const commonOverview = by(['project']).slice(0, 2)
  const portfolioSummary = portfolio ? summarizePortfolioScope(portfolio, knowledge) : []
  const opportunityOverview = portfolio ? portfolioSummary : commonOverview
  switch (template.docType) {
    case 'project_weekly_report': return sections(template, [commonOverview, by(['task', 'phase'], observed), [...by(['risk', 'coordination'], observed), ...by(['risk', 'coordination'], plans)], [...by(['task', 'milestone', 'approval'], plans), ...kb.slice(0, 5)]])
    case 'risk_coordination_summary': return sections(template, [[`有效风险与协调事实共 ${by(['risk', 'coordination'], observed).length} 条。`], by(['risk'], context.facts), by(['coordination'], context.facts), kb.length ? kb : missing('知识库未检索到可引用的风险或协调补充事实。')])
    case 'milestone_warning': {
      const milestones = by(['milestone'], context.facts)
      return sections(template, [[`生成日期 ${datePart(now)}；以下预警仅依据当前计划与状态，不推断未记录的延期原因。`], milestones.length ? milestones : missing('未维护里程碑事实。'), by(['task', 'risk'], context.facts), [...by(['milestone', 'coordination'], plans), ...(kb.length ? kb.slice(0, 5) : missing('未发现可引用的补充事实。'))]])
    }
    case 'stage_progress': return sections(template, [commonOverview, by(['phase', 'task'], context.facts), [...by(['approval'], context.facts), ...by(['task'], observed).filter(line => line.includes('交付物='))], [...by(['task', 'approval', 'coordination'], plans), ...kb.slice(0, 5)]])
    case 'opportunity_weekly_report': return sections(template, [opportunityOverview, [...by(['task', 'coordination', 'approval'], observed), ...(kb.length ? kb.slice(0, 8) : missing('授权范围内没有可用的已解析知识材料，无法形成商机进展事实。'))], [...by(['risk', 'coordination'], context.facts), ...(portfolio ? missing('需逐商机补充风险等级、责任人和预计解决时间。') : [])], [...by(['task', 'milestone', 'approval'], plans), ...(portfolio ? missing('需逐商机补充下期行动、责任人和目标日期。') : [])]])
    case 'customer_visit_minutes': {
      const meetingFacts = knowledge.filter(item => /拜访|会议|访谈|纪要|沟通/.test(`${item.documentName} ${item.folderPath ?? ''} ${item.sectionPath ?? ''}`))
      if (!meetingFacts.length) return sections(template, [[...opportunityOverview, ...missing(`会议时间、地点、参会人员及拜访对象；${portfolio ? '授权范围内' : '当前知识库'}没有可识别的会议/拜访事实。`)], missing('客户沟通内容及原话证据。'), missing('会议结论、责任人、截止时间及行动项。'), ['待补：应上传或录入客户拜访纪要/会议记录后再生成正式纪要。']])
      return sections(template, [[...opportunityOverview, ...missing('会议时间、地点、参会人员如未在下列证据中出现，需人工补充。')], meetingFacts.map(formatKnowledgeFact), [...by(['coordination', 'task'], plans), ...meetingFacts.slice(0, 5).map(formatKnowledgeFact)], missing('请核对参会人、客户确认口径和行动项责任人。')])
    }
    case 'requirement_analysis': return sections(template, [opportunityOverview, kb.length ? kb : missing('授权范围内没有可用的已解析需求材料。'), [...by(['risk', 'coordination', 'approval'], context.facts), ...(portfolio ? missing('需按来源项目确认需求约束、依赖及冲突口径。') : [])], missing('需求优先级、验收标准、边界条件及客户确认记录。')])
    case 'opportunity_handover': return sections(template, [opportunityOverview, kb.length ? kb.slice(0, 8) : missing('授权范围内没有可用的客户或需求材料。'), [...by(['risk', 'coordination'], context.facts), ...(portfolio ? missing('需逐商机补充风险、依赖和责任人。') : [])], [...by(['task', 'milestone', 'approval'], plans), ...missing('接收人、移交时间、商务边界和未决事项确认。')]])
  }
}

function sections(template: ProjectDocumentTemplate, bodies: string[][]): DocumentSection[] {
  return template.sectionTitles.map((title, index) => ({ title, paragraphs: bodies[index]?.length ? bodies[index] : ['当前数据范围内无可引用事实。'] }))
}

async function renderDocx(template: ProjectDocumentTemplate, context: ProjectContext, knowledge: KnowledgeFact[], sectionsData: DocumentSection[], now: Date, portfolio?: PortfolioScope): Promise<Buffer> {
  const evidence = [
    ...(portfolio ? [`[授权范围:${portfolio.authorization.scope}] ${portfolio.projects.map(project => `${project.code}(${project.id})`).join('、') || '授权项目元数据待补'}`] : []),
    ...context.facts.map(item => `[业务数据库:${item.sourceType}:${item.sourceId}] ${item.label}`),
    ...knowledge.map(item => `[知识库:document:${item.documentId}] ${item.sourceProjectCode ? `来源项目=${item.sourceProjectCode}；` : ''}${item.documentName}${item.sectionPath ? `｜${item.sectionPath}` : ''}`),
  ]
  const children: Paragraph[] = [
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${context.projectName}${template.title}`, bold: true, font: { name: HEADING_FONT, eastAsia: HEADING_FONT }, size: 36 })], spacing: { after: 160 } }),
    meta(`模板标识：${template.templateId}@${template.version}`),
    meta(`生成日期：${datePart(now)}`),
    meta(`数据范围：${template.dataRange}${portfolio ? `；服务端授权项目 ${portfolio.authorization.authorizedProjectIds.length} 个` : ''}${context.truncated ? '（结构化上下文已按长度截断）' : ''}`),
  ]
  for (const section of sectionsData) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [headingRun(section.title, 30)], spacing: { before: 240, after: 120 } }))
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [headingRun('事实与事项', 26)], spacing: { before: 120, after: 80 } }))
    for (const text of section.paragraphs) children.push(bodyParagraph(text))
  }
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [headingRun('五、证据与待补信息', 30)], spacing: { before: 240, after: 120 } }))
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [headingRun('来源清单', 26)], spacing: { before: 120, after: 80 } }))
  if (evidence.length) for (const item of evidence) children.push(bodyParagraph(item))
  else children.push(bodyParagraph('待补：当前数据范围内没有可列示证据。'))
  const doc = new Document({
    creator: 'project-manager', title: `${context.projectName}${template.title}`, description: `${template.templateId}@${template.version}`,
    styles: { default: { document: { run: { font: { name: BODY_FONT, eastAsia: BODY_FONT }, size: 24 }, paragraph: { spacing: { line: 360, after: 80 } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${context.projectName}｜${template.title}`, font: { name: BODY_FONT, eastAsia: BODY_FONT }, size: 18, color: '666666' })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '第 ', font: { name: BODY_FONT, eastAsia: BODY_FONT }, size: 18 }), new TextRun({ children: [PageNumber.CURRENT], size: 18 }), new TextRun({ text: ' 页', font: { name: BODY_FONT, eastAsia: BODY_FONT }, size: 18 })] })] }) },
      children,
    }],
  })
  return Packer.toBuffer(doc)
}

function headingRun(text: string, size: number) { return new TextRun({ text, bold: true, font: { name: HEADING_FONT, eastAsia: HEADING_FONT }, size }) }
function bodyParagraph(text: string) { return new Paragraph({ indent: { firstLine: 480 }, children: [new TextRun({ text, font: { name: BODY_FONT, eastAsia: BODY_FONT }, size: 24 })], spacing: { line: 360, after: 80 } }) }
function meta(text: string) { return new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, font: { name: BODY_FONT, eastAsia: BODY_FONT }, size: 20, color: '555555' })], spacing: { after: 40 } }) }
function summarizePortfolioScope(portfolio: PortfolioScope, knowledge: KnowledgeFact[]) {
  const materials = new Map<string, Set<string>>()
  for (const fact of knowledge) {
    const key = fact.sourceProjectCode ?? fact.sourceProjectId ?? '来源项目待识别'
    const names = materials.get(key) ?? new Set<string>()
    names.add(fact.documentName)
    materials.set(key, names)
  }
  const lines = [
    `跨项目授权范围：服务端签发 ${portfolio.authorization.scope}，共 ${portfolio.authorization.authorizedProjectIds.length} 个项目；${portfolio.projects.map(project => `${project.code}（${project.name}）`).join('、') || '项目名称待补'}。`,
    `可用知识材料摘要：共 ${new Set(knowledge.map(item => item.documentId)).size} 份文档、${knowledge.length} 条摘录；${[...materials].map(([project, names]) => `${project}：${[...names].slice(0, 5).join('、')}`).join('；') || '授权范围内暂无已解析且有效的知识材料'}。`,
  ]
  if (portfolio.projects.length < portfolio.authorization.authorizedProjectIds.length) lines.push(`待补：${portfolio.authorization.authorizedProjectIds.length - portfolio.projects.length} 个授权项目缺少可展示的项目元数据。`)
  if (!knowledge.length) lines.push('待补：授权范围内没有可引用知识事实，不能据此推断客户、需求、进展、风险或商务状态。')
  return lines
}
function formatStructuredFact(item: ProjectContextFact) { return `[业务数据库:${item.sourceType}:${item.sourceId}] ${item.label}：${item.text}（事实类型：${item.factType}）` }
function formatKnowledgeFact(item: KnowledgeFact) { const source = item.sourceProjectCode ? `来源项目=${item.sourceProjectCode}；` : ''; return `[知识库:document:${item.documentId}] ${source}${item.documentName}${item.sectionPath ? `｜${item.sectionPath}` : ''}：${item.content}` }
function compact(value: string, max: number) { const text = value.replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text }
function safeFilePart(value: string) { return value.replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80) || 'project' }
function datePart(value: Date) { return value.toISOString().slice(0, 10) }

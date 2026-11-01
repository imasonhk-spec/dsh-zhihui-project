export const PROJECT_DOCUMENT_TYPES = [
  'project_weekly_report',
  'risk_coordination_summary',
  'milestone_warning',
  'stage_progress',
  'opportunity_weekly_report',
  'customer_visit_minutes',
  'requirement_analysis',
  'opportunity_handover',
] as const

export type ProjectDocumentType = typeof PROJECT_DOCUMENT_TYPES[number]
export type ProjectDocumentTemplate = {
  docType: ProjectDocumentType
  templateId: string
  version: string
  title: string
  dataRange: string
  sectionTitles: readonly string[]
}

const entries: ProjectDocumentTemplate[] = [
  { docType: 'project_weekly_report', templateId: 'PM-DOC-PWR', version: '1.0.0', title: '项目周报', dataRange: '当前项目结构化数据及已入库知识文档', sectionTitles: ['一、本期概况', '二、当前进展', '三、风险与协调事项', '四、下一步安排'] },
  { docType: 'risk_coordination_summary', templateId: 'PM-DOC-RCS', version: '1.0.0', title: '风险与协调事项汇总', dataRange: '当前有效风险、未关闭协调事项及相关知识库事实', sectionTitles: ['一、风险概况', '二、风险明细', '三、协调事项', '四、处置建议'] },
  { docType: 'milestone_warning', templateId: 'PM-DOC-MW', version: '1.0.0', title: '里程碑预警', dataRange: '当前里程碑、任务计划及相关知识库事实', sectionTitles: ['一、预警概况', '二、里程碑状态', '三、关联任务与影响', '四、跟进安排'] },
  { docType: 'stage_progress', templateId: 'PM-DOC-SP', version: '1.0.0', title: '阶段进展报告', dataRange: '当前有效阶段、任务、报批事项及相关知识库事实', sectionTitles: ['一、项目概况', '二、阶段进展', '三、交付与报批', '四、待推进事项'] },
  { docType: 'opportunity_weekly_report', templateId: 'PM-DOC-OWR', version: '1.0.0', title: '商机周报', dataRange: '当前项目/OPP-MASTER结构化数据及已入库商机事实', sectionTitles: ['一、商机概况', '二、本期进展', '三、风险与依赖', '四、下期计划'] },
  { docType: 'customer_visit_minutes', templateId: 'PM-DOC-CVM', version: '1.0.0', title: '客户拜访纪要', dataRange: '当前项目结构化数据及知识库中的会议/拜访事实', sectionTitles: ['一、会议基本信息', '二、沟通事项', '三、结论与行动项', '四、待补信息'] },
  { docType: 'requirement_analysis', templateId: 'PM-DOC-RA', version: '1.0.0', title: '需求分析', dataRange: '当前项目结构化数据及知识库中的需求事实', sectionTitles: ['一、背景与目标', '二、已知需求', '三、约束与依赖', '四、待确认需求'] },
  { docType: 'opportunity_handover', templateId: 'PM-DOC-OH', version: '1.0.0', title: '商机移交单', dataRange: '当前项目/OPP-MASTER结构化数据及已入库商机事实', sectionTitles: ['一、商机基本信息', '二、客户与需求事实', '三、风险及依赖', '四、移交事项'] },
]

export const PROJECT_DOCUMENT_TEMPLATE_REGISTRY: Readonly<Record<ProjectDocumentType, ProjectDocumentTemplate>> = Object.freeze(
  Object.fromEntries(entries.map(item => [item.docType, Object.freeze(item)])) as Record<ProjectDocumentType, ProjectDocumentTemplate>,
)

export function isProjectDocumentType(value: unknown): value is ProjectDocumentType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROJECT_DOCUMENT_TEMPLATE_REGISTRY, value)
}

export function getProjectDocumentTemplate(value: unknown): ProjectDocumentTemplate {
  if (!isProjectDocumentType(value)) throw new Error('ai_document_type_invalid')
  return PROJECT_DOCUMENT_TEMPLATE_REGISTRY[value]
}

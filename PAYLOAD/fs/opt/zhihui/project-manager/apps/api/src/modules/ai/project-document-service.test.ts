import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { generateProjectDocument, DOCX_MIME } from './project-document-service.ts'
import { PROJECT_DOCUMENT_TYPES, PROJECT_DOCUMENT_TEMPLATE_REGISTRY } from './document-template-registry.ts'
import type { ProjectContext } from './project-context-service.ts'

const context: ProjectContext = {
  projectId: '11111111-1111-4111-8111-111111111111',
  projectCode: 'DEMO-01',
  projectName: '示例项目',
  truncated: false,
  text: '',
  facts: [
    { sourceType: 'project', sourceId: '11111111-1111-4111-8111-111111111111', label: '项目', text: '编号=DEMO-01；名称=示例项目；状态=in_progress；进度=40%；健康度=attention；客户=甲方', factType: 'observed' },
    { sourceType: 'task', sourceId: '22222222-2222-4222-8222-222222222222', label: '任务 1.1', text: '完成原型；状态=in_progress；进度=60%；交付物=原型', factType: 'observed' },
    { sourceType: 'risk', sourceId: '33333333-3333-4333-8333-333333333333', label: '风险 R-01', text: '接口资料未到位；等级=high；状态=following；影响=联调时间', factType: 'observed' },
    { sourceType: 'milestone', sourceId: '44444444-4444-4444-8444-444444444444', label: '里程碑计划', text: '计划日期=2026-09-30；负责人=项目经理', factType: 'plan' },
  ],
}

const knowledge = [{ documentId: '55555555-5555-4555-8555-555555555555', documentName: '需求确认记录', folderPath: '02-需求与设计', sectionPath: '需求范围', content: '客户确认首期范围为原型与接口联调。' }]

test('eight registered document types generate valid DOCX and archive', async () => {
  assert.equal(PROJECT_DOCUMENT_TYPES.length, 8)
  assert.equal(Object.keys(PROJECT_DOCUMENT_TEMPLATE_REGISTRY).length, 8)
  const archived: string[] = []
  for (const docType of PROJECT_DOCUMENT_TYPES) {
    const result = await generateProjectDocument(context.projectId, docType, {
      context: async () => context,
      knowledge: async () => knowledge,
      archive: async (_projectId, kind, upload) => {
        assert.equal(kind, 'weekly-report')
        assert.equal(upload.mimeType, DOCX_MIME)
        assert.ok(upload.fileName.endsWith('.docx'))
        archived.push(docType)
        return { id: `archive-${docType}` } as never
      },
      now: () => new Date('2026-09-17T12:00:00.000Z'),
    })
    assert.equal(result.mimeType, DOCX_MIME)
    assert.ok(result.fileName.endsWith('.docx'))
    assert.deepEqual([...result.body.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04])
    const zip = await JSZip.loadAsync(result.body)
    const documentXml = await zip.file('word/document.xml')!.async('string')
    assert.match(documentXml, /示例项目/)
    assert.match(documentXml, new RegExp(PROJECT_DOCUMENT_TEMPLATE_REGISTRY[docType].templateId))
    assert.match(documentXml, /证据与待补信息/)
  }
  assert.deepEqual(archived, [...PROJECT_DOCUMENT_TYPES])
})

test('OPP-MASTER opportunity documents expose authorized scope, material summary and missing facts', async () => {
  const opportunityTypes = ['opportunity_weekly_report', 'customer_visit_minutes', 'requirement_analysis', 'opportunity_handover'] as const
  const portfolioContext = { ...context, projectCode: 'OPP-MASTER', projectName: '商机总库', facts: context.facts.filter(item => item.sourceType === 'project') }
  for (const docType of opportunityTypes) {
    const result = await generateProjectDocument(context.projectId, docType, {
      context: async () => portfolioContext,
      portfolioScope: async () => ({
        authorization: { scope: 'authorized-project-set', portfolioProjectId: context.projectId, authorizedProjectIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] },
        projects: [
          { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code: 'OPP-001', name: '甲商机' },
          { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', code: 'OPP-002', name: '乙商机' },
        ],
      }),
      knowledge: async (_projectId, portfolio, authorizedProjectIds) => {
        assert.equal(portfolio, true)
        assert.deepEqual(authorizedProjectIds, ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])
        return [{ ...knowledge[0], sourceProjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceProjectCode: 'OPP-001', sourceProjectName: '甲商机' }]
      },
      archive: async () => ({ id: `archive-${docType}` }) as never,
      now: () => new Date('2026-09-17T12:00:00.000Z'),
    })
    const zip = await JSZip.loadAsync(result.body)
    const xml = await zip.file('word/document.xml')!.async('string')
    assert.match(xml, /跨项目授权范围/)
    assert.match(xml, /authorized-project-set/)
    assert.match(xml, /OPP-001（甲商机）/)
    assert.match(xml, /可用知识材料摘要/)
    assert.match(xml, /来源项目=OPP-001/)
    assert.match(xml, /待补/)
  }
})

test('customer visit minutes explicitly marks missing meeting facts', async () => {
  const result = await generateProjectDocument(context.projectId, 'customer_visit_minutes', {
    context: async () => context,
    knowledge: async () => [],
    archive: async () => ({ id: 'archive-visit' }) as never,
    now: () => new Date('2026-09-17T12:00:00.000Z'),
  })
  const zip = await JSZip.loadAsync(result.body)
  const xml = await zip.file('word/document.xml')!.async('string')
  assert.match(xml, /待补/)
  assert.match(xml, /当前知识库没有可识别的会议\/拜访事实/)
})

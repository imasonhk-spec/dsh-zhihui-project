import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db, pool } from '../apps/api/src/db/client.ts'
import { approvalItems, coordinationItems, knowledgeBases, knowledgeFolders, milestones, projectPhases, projects, risks, tasks } from '../apps/api/src/db/schema.ts'

if (process.env.ALLOW_DEMO_SEED !== 'true') {
  console.error('Demo seed is disabled. Set ALLOW_DEMO_SEED=true only for an explicit local fixture reset.')
  process.exit(1)
}

const mainProjectId = '00000000-0000-0000-0000-000000000001'
const projectRows = [
  ['P-001', '龙岗区AI+HR“数智组工”系统', 'in_progress', 'healthy', 48, '智慧党建 / AI+HR', '区委组织部'],
  ['P-002', '龙岗区智慧应急指挥平台（一期）', 'in_progress', 'healthy', 72, '智慧应急', '区政务和数据局'],
  ['P-003', '区政务服务中心“一网通办”能力升级', 'in_progress', 'attention', 63, '政务服务', '区政务和数据局'],
  ['P-004', '龙岗区城市运行管理服务平台', 'in_progress', 'risk', 41, '城市治理', '区城市管理和综合执法局'],
  ['P-005', '区属国企国有资产在线监管系统', 'in_progress', 'healthy', 56, '国资监管', '区国资局'],
  ['P-006', '龙岗区智慧社区综合服务平台', 'in_progress', 'attention', 38, '智慧社区', '区政务和数据局'],
  ['P-007', '龙岗区教育公共服务平台（二期）', 'in_progress', 'healthy', 55, '智慧教育', '区教育局'],
  ['P-008', '龙岗区医疗卫生数据中枢', 'planning', 'attention', 22, '医疗数据', '区卫生健康局'],
  ['P-009', '区统一身份认证平台（IAM）升级工程', 'in_progress', 'healthy', 86, '基础平台', '区政务和数据局'],
  ['P-010', '龙岗区产业经济运行监测平台', 'in_progress', 'attention', 34, '产业经济', '区发展和改革局'],
] as const

const phaseRows = [
  { projectId: mainProjectId, code: 'P1', name: '项目需求与设计', sortOrder: 1, status: 'in_progress' as const, progress: 62 },
  { projectId: mainProjectId, code: 'P2', name: '系统开发与联调', sortOrder: 2, status: 'in_progress' as const, progress: 35 },
  { projectId: mainProjectId, code: 'P3', name: '部署与安全测评', sortOrder: 3, status: 'not_started' as const, progress: 0 },
  { projectId: mainProjectId, code: 'P4', name: '试运行与验收', sortOrder: 4, status: 'not_started' as const, progress: 0 },
]

const taskRows = [
  ['1.1', '组工系统数据接口文档提供', '中电数据产业集团', '胡鹏超', 'delayed', 'high', 80, '2026-08-12', '2026-08-21', '接口文档完整版'],
  ['1.2', '协调政务和数据局申请应用域名', '区数据集团', '王忻欤', 'completed', 'high', 100, '2026-08-18', '2026-08-21', '应用域名'],
  ['1.3', '数据库设计文档整合与审核', '区数据集团', '王忻欤', 'completed', 'high', 100, '2026-08-15', '2026-08-22', '数据库设计文档'],
  ['1.4', '确认安全测评具体事项', '区数据集团', '王忻欤', 'ready', 'high', 0, '2026-08-25', '2026-08-29', '安全测评范围确认'],
  ['2.1', 'Logo图标设计与交付', '区数据集团', '王忻欤', 'completed', 'high', 100, '2026-08-18', '2026-08-22', 'Logo源文件'],
  ['2.2', '首页领导驾驶舱设计需求确认', '区数据集团', '王忻欤', 'in_progress', 'high', 50, '2026-08-22', '2026-08-27', '需求确认记录'],
  ['2.3', '首页领导驾驶舱设计', '区数据集团', '王忻欤', 'in_progress', 'high', 35, '2026-08-25', '2026-09-01', '首页设计稿'],
  ['3.5', '与科大讯飞协调自定义音色', '科大讯飞', '王忻欤', 'in_progress', 'high', 50, '2026-08-20', '2026-08-27', '音色方案确认'],
  ['3.6', '与科大讯飞音色联调', '科大讯飞', '王忻欤', 'not_started', 'high', 0, '2026-08-28', '2026-09-04', '音色联调结果'],
  ['5.1', '大模型推理服务器部署', '区数据集团', '王忻欤', 'in_progress', 'high', 50, '2026-08-25', '2026-08-31', '推理服务器环境'],
  ['6.2', '内外网数据协调', '区政务和数据局', '王忻欤', 'in_progress', 'high', 40, '2026-08-22', '2026-08-28', '数据交换方案'],
  ['6.3', '启动安全测评', '区数据集团', '王忻欤', 'not_started', 'medium', 0, '2026-09-01', '2026-09-20', '安全测评报告'],
] as const

const riskRows = [
  ['RISK-001', '中电接口文档缺失关键接口', '高', 'closed', '中电数据产业集团', '完整版接口文档已于 8.21 18:30 获取，操作日志暂不对接。', '补充接口文档并确认暂不对接范围', '2026-08-21'],
  ['RISK-002', '中电未提供驾驶舱参考页面，首页设计受阻', '高', 'following', '中电数据产业集团', '驾驶舱参考页面未提供，影响 UI 设计定稿和领导演示准备。', '持续催办并准备降级参考方案', '2026-08-27'],
  ['RISK-003', '数字人音色方案存在双重不确定性', '高', 'following', '区数据集团 / 科大讯飞', '自定义音色能力和领导确认均未闭环，可能影响 09-01 演示。', '推进领导确认并与供应商确认音色能力', '2026-08-27'],
  ['RISK-004', '龙岗湾嵌入需求不清晰', '高', 'closed', '龙岗湾项目组', '已确认不再纳入干部成长伙伴功能。', '完成需求变更记录和范围基线更新', '2026-08-22'],
  ['RISK-005', '首页-工作人员设计方案需求悬空', '中', 'closed', '区政务和数据局', '已确认 9 月底前暂时不做工作人员首页。', '记录范围暂缓决定', '2026-08-26'],
  ['RISK-007', '基础环境部署内外网服务器联调适配', '高', 'following', '区政务和数据局 / 龙岗数据 / 中电数据', '内网 5 台与外网 3 台资源依赖协调，影响 09-08 环境部署节点。', '每日跟进资源协调，准备部署降级方案', '2026-09-08'],
] as const

const coordinationRows = [
  ['C1', '资源协调', '待区政务和数据局内部协调服务器资源（内网5台 + 外网3台）', '影响自研数字人部署及联调、基础环境部署阶段 09-08 完成', '区政务和数据局', '王忻欤', 'high', 'communicating', 50, '2026-08-28'],
  ['C2', '网络与数据', '内外网数据协调（WBS 6.2）', '干部档案和考察数据回流链路需跨内外网交换', '区政务和数据局', '王忻欤', 'high', 'communicating', 40, '2026-08-28'],
  ['C3', '安全合规', '与政数局确认安全测评具体事项（WBS 1.4）', '需确认测评范围、材料清单和启动条件', '区政务和数据局', '王忻欤', 'high', 'to_start', 0, '2026-08-29'],
  ['C4', '供应商协同', '中电驾驶舱参考页面催办（风险 RISK-002）', '影响首页设计定稿和领导演示', '中电数据产业集团', '王忻欤', 'high', 'communicating', 40, '2026-08-26'],
  ['C5', '供应商协同', '数字人多音色需求与数据科 / 科大讯飞协调（WBS 3.5）', '影响音色联调及 09-01 数字人演示', '科大讯飞 / 区组织部', '王忻欤', 'high', 'communicating', 50, '2026-08-27'],
  ['C6', '需求确认', '数字人形象方案待组织部领导确认（WBS 3.2）', '影响数字人形象制作', '区委组织部', '王忻欤', 'medium', 'communicating', 50, '2026-08-28'],
  ['C7', '供应商协同', '大模型推理服务器部署推进（WBS 5.1）', '影响基础环境部署', '区数据集团', '王忻欤', 'medium', 'to_start', 0, '2026-08-31'],
  ['C8', '资源协调', '协调政务和数据局申请应用域名（WBS 1.2）', '已填写最新域名申请表并调试到最新域名环境', '区政务和数据局', '王忻欤', 'low', 'resolved', 100, '2026-08-21'],
  ['C9', '供应商协同', '组工系统接口文档补充催办（RISK-001）', '已获取完整接口文档，事项关闭', '中电数据产业集团', '王忻欤', 'high', 'resolved', 100, '2026-08-21'],
  ['C10', '需求确认', '组工系统操作日志对接口径确认（WBS 4.7）', '已确认 9 月底不上操作日志接口', '中电数据产业集团', '王忻欤', 'medium', 'resolved', 100, '2026-08-19'],
  ['C11', '需求确认', '龙岗湾嵌入需求确认（RISK-004）', '已确认不纳入干部成长伙伴功能', '龙岗湾项目组', '王忻欤', 'high', 'resolved', 100, '2026-08-22'],
  ['C12', '需求确认', '首页-工作人员设计方案需求确认（RISK-005）', '已确认 9 月底前暂时不做', '区政务和数据局 / 龙岗数据', '王忻欤', 'medium', 'resolved', 100, '2026-08-26'],
] as const

const approvalRows = [
  ['s1', '项目建议书', '项目建议书内容确认并正式提交政数局审核', '正式提交政数局审核的项目建议书', '华策咨询、数据集团、中电数据', 'completed', '2026-07-14', '2026-07-26'],
  ['s1', '项目建议书', '项目建议书审批跟进及意见调整', '8.20 已通过局内审批，含批复及调整留痕', '华策咨询、数据集团、中电数据', 'completed', '2026-07-27', '2026-08-31'],
  ['s1', '项目建议书', '上报区发改批复', '项目建议书审批批复', '区发改', 'not_started', '2026-09-01', '2026-09-15'],
  ['s2', '项目初设编制与审批', '系统功能清单评审确认', '系统功能清单、评审确认纪要', '华策咨询、数据集团、中电数据', 'completed', '2026-07-29', '2026-07-29'],
  ['s2', '项目初设编制与审批', '技术路线选型与方案确认', '技术路线选型意见、总体技术方案要点', '数据集团、中电数据', 'completed', '2026-07-29', '2026-07-29'],
  ['s2', '项目初设编制与审批', '项目初设初稿编制', '项目初设初稿、概算测算基础表', '华策咨询、数据集团、中电数据', 'completed', '2026-07-28', '2026-08-15'],
  ['s2', '项目初设编制与审批', '初设内部评审及修改', '内部评审意见、初设修改稿', '华策咨询、数据集团、中电数据', 'in_progress', '2026-08-24', '2026-08-30'],
  ['s2', '项目初设编制与审批', '与政数局完成初设交流评审并调整', '交流评审纪要、初设调整稿', '华策咨询、数据集团、中电数据', 'not_started', '2026-09-16', '2026-09-20'],
  ['s2', '项目初设编制与审批', '局党组会审议', '局党组会审议意见', '政数局', 'not_started', '2026-09-21', '2026-10-11'],
  ['s2', '项目初设编制与审批', '初设提交政数局审批及意见调整', '初设送审材料、审批意见答复和修订稿', '华策咨询、数据集团、中电数据', 'not_started', '2026-10-12', '2026-10-18'],
  ['s2', '项目初设编制与审批', '提交区发改批复', '初设送审材料、审批意见答复和修订稿', '区发改', 'not_started', '2026-10-19', '2026-11-01'],
  ['s3', '项目招投标', '采购意向公示（30 天）', '采购意向公示', '政数局、数据集团', 'not_started', '2026-11-01', '2026-11-30'],
  ['s3', '项目招投标', '招标文件编制与确认', '招标文件', '政数局、数据集团、中电数据', 'not_started', '2026-11-02', '2026-11-06'],
  ['s3', '项目招投标', '投标文件编制', '投标文件初稿及定稿', '数据集团、中电数据', 'not_started', '2026-11-02', '2026-11-06'],
  ['s3', '项目招投标', '合作伙伴采购费用商务谈判', '合作伙伴项目报价', '数据集团、中电数据', 'not_started', '2026-11-06', '2026-11-13'],
  ['s3', '项目招投标', '招标公告挂网公示', '招标公告挂网', '政数局、数据集团、中电数据', 'not_started', '2026-11-13', '2026-11-18'],
  ['s3', '项目招投标', '投标、开标、评标、中标通知及公示', '评标结果、中标通知书、中标公示', '政数局、数据集团、中电数据', 'not_started', '2026-11-18', '2026-11-30'],
  ['s4', '项目合同签订', '数据集团公司与局方签订技术服务合同', '技术服务合同', '政数局、数据集团', 'not_started', '2026-11-30', '2026-12-05'],
  ['s4', '项目合同签订', '同步准备合作伙伴招投标工作', '合作伙伴采购文件、评审或招投标资料', '数据集团、中电数据', 'not_started', '2026-11-25', '2026-12-10'],
  ['s4', '项目合同签订', '各合作伙伴合同签订', '合作伙伴合同', '数据集团、中电数据', 'not_started', '2026-12-11', '2026-12-20'],
] as const

const folders = ['01-项目管理过程', '02-需求与设计', '03-开发与测试', '04-部署与运维', '05-最终交付物', '06-合同与商务', '07-前期筹备与变更', '08-知识传递与总结']

await db.transaction(async tx => {
  await tx.insert(projects).values(projectRows.map(([code, name, status, health, progress, category, clientName], index) => ({ id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`, code, name, status: status as 'planning' | 'in_progress', health, progress, category, clientName, startDate: '2026-05-12', plannedEndDate: '2026-11-28' }))).onConflictDoNothing()
  await tx.insert(projectPhases).values(phaseRows).onConflictDoNothing()
  const phase = await tx.select({ id: projectPhases.id }).from(projectPhases).where(eq(projectPhases.code, 'P1')).limit(1)
  await tx.insert(tasks).values(taskRows.map(([wbsCode, name, vendor, ownerName, status, priority, progress, plannedStartDate, plannedEndDate, deliverable]) => ({ projectId: mainProjectId, phaseId: phase[0]?.id, wbsCode, name, vendor, ownerName, status: status as never, priority: priority as never, progress, plannedStartDate, plannedEndDate, deliverable }))).onConflictDoNothing()
  await tx.insert(milestones).values([
    { projectId: mainProjectId, name: '组工系统接口文档完整交付', plannedDate: '2026-08-17', status: 'completed', type: '关键', ownerName: '中电数据产业集团 / 胡鹏超', description: '获取完整版接口文档，操作日志接口暂不对接。' },
    { projectId: mainProjectId, name: 'UI设计定稿（Logo+登录页+首页）', plannedDate: '2026-08-27', status: 'in_progress', type: '关键', ownerName: '区数据集团 / 王忻欤', description: '完成 Logo、登录页、首页驾驶舱设计稿。' },
    { projectId: mainProjectId, name: '基础环境部署阶段完成', plannedDate: '2026-09-08', status: 'in_progress', type: '关键', ownerName: '区数据集团 / 王忻欤', description: '内外网服务器完成配置并具备联调条件。' },
    { projectId: mainProjectId, name: '安全测评完成', plannedDate: '2026-09-20', status: 'not_started', type: '关键', ownerName: '区数据集团 / 王忻欤', description: '输出安全测评报告和整改闭环。' },
    { projectId: mainProjectId, name: '试运行启动', plannedDate: '2026-09-30', status: 'not_started', type: '关键', ownerName: '区数据集团 / 王忻欤', description: '系统进入试运行阶段。' },
  ]).onConflictDoNothing()
  await tx.insert(risks).values(riskRows.map(([code, name, level, status, source, description, mitigation, expectedResolutionDate]) => ({ projectId: mainProjectId, code, name, level: (level === '高' ? 'high' : 'medium') as 'medium' | 'high', status: status as 'closed' | 'following', source, description, impact: description, mitigation, expectedResolutionDate }))).onConflictDoNothing()
  await tx.insert(coordinationItems).values(coordinationRows.map(([code, category, title, description, counterparty, ownerName, priority, status, progress, dueDate]) => ({ projectId: mainProjectId, code, category, title, description, counterparty, ownerName, priority: priority as 'low' | 'medium' | 'high', status: status as 'to_start' | 'communicating' | 'resolved', progress, dueDate }))).onConflictDoNothing()
  await tx.insert(approvalItems).values(approvalRows.map(([stageCode, stageName, taskName, deliverable, responsibleParty, status, plannedStartDate, plannedEndDate]) => ({ projectId: mainProjectId, stageCode, stageName, taskName, deliverable, responsibleParty, status, plannedStartDate, plannedEndDate }))).onConflictDoNothing()
  let kb = await tx.select({ id: knowledgeBases.id }).from(knowledgeBases).where(eq(knowledgeBases.projectId, mainProjectId)).limit(1)
  if (!kb[0]) kb = await tx.insert(knowledgeBases).values({ projectId: mainProjectId, name: '数智组工项目知识库', description: '项目档案、过程资料、交付物和结构化项目数据的统一知识库。', scope: 'project' }).returning({ id: knowledgeBases.id })
  if (kb[0]) await tx.insert(knowledgeFolders).values(folders.map((name, index) => ({ knowledgeBaseId: kb[0].id, name, path: name, sortOrder: index + 1 }))).onConflictDoNothing()
})

await pool.end()
console.log('Seeded project portfolio, current project WBS, risks, coordination items, milestones and knowledge folders.')


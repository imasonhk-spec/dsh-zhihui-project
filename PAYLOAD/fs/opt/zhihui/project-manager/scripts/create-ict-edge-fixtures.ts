import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ExcelJS from 'exceljs'

const output = resolve(process.argv[2] ?? '.tmp/ict-edge-fixtures')
await mkdir(output, { recursive: true })

const csv = (headers: string[], rows: string[][]) =>
  Buffer.from([headers, ...rows].map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\n'))

await writeFile(resolve(output, 'project-01-baseline.csv'), csv(
  ['wbsCode', 'name', 'vendor', 'ownerName', 'plannedStartDate', 'plannedEndDate', 'priority', 'status', 'progress'],
  [
    ['1', 'Edge验收阶段', '厂商A', '验收人', '2026-09-14', '2026-09-20', 'high', 'in_progress', '20'],
    ['1.1', 'Edge验收子任务', '厂商A', '验收人', '2026-09-14', '2026-09-16', 'medium', 'not_started', '0'],
    ['1.2', '待归档任务', '厂商B', '验收人', '2026-09-17', '2026-09-18', 'low', 'not_started', '0'],
    ['1.4', '保持不变任务', '厂商D', '验收人', '2026-09-18', '2026-09-19', 'low', 'not_started', '0'],
  ],
))
await writeFile(resolve(output, 'project-02-changes.csv'), csv(
  ['wbsCode', 'name', 'vendor', 'ownerName', 'plannedStartDate', 'plannedEndDate', 'priority', 'status', 'progress'],
  [
    ['1', 'Edge验收阶段', '厂商A', '验收人', '2026-09-14', '2026-09-22', 'critical', 'in_progress', '40'],
    ['1.1', 'Edge验收子任务', '', '验收人', '2026-09-14', '2026-09-16', 'medium', 'in_progress', '30'],
    ['1.3', '本批新增任务', '厂商C', '验收人', '2026-09-19', '2026-09-21', 'high', 'not_started', '0'],
    ['1.4', '保持不变任务', '厂商D', '验收人', '2026-09-18', '2026-09-19', 'low', 'not_started', '0'],
  ],
))

async function opportunityWorkbook(path: string, rows: Array<Array<string | number>>) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('商机项目')
  sheet.addRow(['ICT-1 Edge 145验收夹具'])
  sheet.addRow([])
  sheet.addRow([])
  sheet.addRow([])
  for (const row of rows) sheet.addRow(row)
  await workbook.xlsx.writeFile(resolve(output, path))
}

await opportunityWorkbook('opportunity-01-baseline.xlsx', [
  ['EDGE-OPP-001', 'Edge验收商机一', '', '客户A', '团队A', '售前甲', 100, '20%', '高', '2026-12-01', '基线背景', '基线需求', 'lead', 'active', '首次录入', '政企'],
  ['EDGE-OPP-002', '待归档商机', '', '客户B', '团队B', '售前乙', 50, '10%', '中', '2027-01-15', '待归档', '待归档', 'lead', 'active', '首次录入', '政企'],
  ['EDGE-OPP-004', '保持不变商机', '', '客户D', '团队D', '售前丁', 60, '12%', '中', '2027-03-01', '保持不变', '保持不变', 'lead', 'active', '保持不变', '政企'],
  ['EDGE-OPP-005', '纯修改商机', '', '客户E', '团队E', '售前戊', 40, '10%', '中', '2027-04-01', '纯修改基线', '保持需求', 'lead', 'active', '纯修改基线', '政企'],
  ['EDGE-OPP-006', '签单时间清空商机', '', '客户F', '团队F', '售前己', 30, '8%', '低', '2027-05-01', '清空日期基线', '保持需求', 'lead', 'active', '日期待调整', '政企'],
])
await opportunityWorkbook('opportunity-02-changes.xlsx', [
  ['EDGE-OPP-001', 'Edge验收商机一', '', '客户A', '团队A', '售前甲', 120, '25%', '高', '2026-12-31', '背景已更新', '', 'proposal', 'active', '推进中', '政企'],
  ['EDGE-OPP-003', '本批新增商机', '', '客户C', '团队C', '售前丙', 80, '15%', '中', '2027-02-01', '新增背景', '新增需求', 'lead', 'active', '新增', '政企'],
  ['EDGE-OPP-004', '保持不变商机', '', '客户D', '团队D', '售前丁', 60, '12%', '中', '2027-03-01', '保持不变', '保持不变', 'lead', 'active', '保持不变', '政企'],
  ['EDGE-OPP-005', '纯修改商机', '', '客户E', '团队E', '售前戊', 45, '10%', '中', '2027-03-15', '纯修改基线', '保持需求', 'lead', 'active', '金额与日期已提前', '政企'],
  ['EDGE-OPP-006', '签单时间清空商机', '', '客户F', '团队F', '售前己', 30, '8%', '低', '', '清空日期基线', '保持需求', 'lead', 'active', '日期已清空', '政企'],
])

console.log(`ICT Edge fixtures created: ${output}`)

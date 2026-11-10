import 'dotenv/config'
import ExcelJS from 'exceljs'
import { pool } from '../apps/api/src/db/client.ts'
import { ownerRanks, getDeliveryMeetingTodoDashboard } from '../apps/api/src/modules/imports/delivery-meeting-todo-dashboard-service.ts'
import { previewDeliveryMeetingTodos } from '../apps/api/src/modules/imports/delivery-meeting-todo-service.ts'

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message)}
function todo(ownerName:string,status:string,index:number){const now=new Date();return{id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,importId:'00000000-0000-4000-8000-000000000000',projectId:null,sourceRow:index,sequence:index,establishedDate:null,title:`T${index}`,ownerName,deadlineText:null,dueDate:null,projectNameRaw:null,status,resultRemark:null,createdAt:now,updatedAt:now}}

const previous=[todo('甲','completed',1),todo('甲','completed',2),todo('乙','completed',3),todo('乙','pending',4),todo('丙','pending',5),todo('丙','pending',6),todo('戊','pending',7)]
const current=[todo('乙','completed',8),todo('乙','completed',9),todo('甲','completed',10),todo('甲','pending',11),todo('丁','completed',12),todo('戊','pending',13)]
const ranked=ownerRanks(current as never,previous as never)
assert(ranked.map(row=>row.ownerName).join(',')==='乙,丁,甲,戊','owner_completion_rate_sort_invalid')
assert(ranked.find(row=>row.ownerName==='乙')?.trend==='up','owner_rank_up_missing')
assert(ranked.find(row=>row.ownerName==='甲')?.trend==='down','owner_rank_down_missing')
assert(ranked.find(row=>row.ownerName==='戊')?.trend==='same','owner_rank_same_missing')
assert(ranked.find(row=>row.ownerName==='丁')?.trend==='new','owner_rank_new_missing')

const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('工作表1');sheet.addRow(['序号','待办建立时间','待办事项','责任人','截止时间/节点','所属项目','状态','备注（已完成请简要说明结果）']);sheet.addRow([1,'2026-09-01','状态解析测试','测试人','2026-09-02','不存在的测试项目','未完成','']);const body=Buffer.from(await workbook.xlsx.writeBuffer());const preview=await previewDeliveryMeetingTodos('status-test.xlsx',body);assert(preview.rows[0]?.status==='pending','unfinished_status_was_misclassified');assert(preview.rows[0]?.dueDate==='2026-09-02','text_date_was_not_parsed')

const dashboard=await getDeliveryMeetingTodoDashboard();assert(dashboard.items.length===dashboard.statistics.total,'dashboard_total_mismatch');assert(dashboard.owners.every((row,index,array)=>index===0||array[index-1]!.completionRate>=row.completionRate),'real_owner_sort_invalid');assert(dashboard.analysis&&dashboard.analysis.judgments.length>0&&dashboard.analysis.actions.length>0,'automatic_analysis_missing');assert(dashboard.analysis.metrics.length===4,'analysis_metrics_invalid')
console.log(JSON.stringify({ok:true,checks:['owner-rate-desc','rank-up-down-same-new','unfinished-status-first','text-date-parsing','dashboard-real-data','analysis-ready-on-entry']}))
await pool.end()

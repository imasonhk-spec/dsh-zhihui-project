import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {Pool} from 'pg'

const source=process.env.DATABASE_URL??''
const parsed=new URL(source)
if(!['127.0.0.1','localhost'].includes(parsed.hostname))throw new Error('integration_db_guard_non_local')
const admin=new URL(source);admin.pathname='/postgres'
const name=`ict_project_test_${process.pid}_${Date.now()}`
const url=new URL(source);url.pathname=`/${name}`
const quote=(v:string)=>`"${v.replaceAll('"','""')}"`
const csv=(headers:string[],rows:string[][])=>Buffer.from([headers,...rows].map(row=>row.map(v=>`"${v.replaceAll('"','""')}"`).join(',')).join('\n'))

async function withDatabase(run:(pool:Pool)=>Promise<void>){const control=new Pool({connectionString:admin.toString()});let productionPool:Pool|undefined;try{await control.query(`CREATE DATABASE ${quote(name)}`);execFileSync('pnpm',['db:migrate'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:url.toString()},stdio:'pipe'});process.env.DATABASE_URL=url.toString();const pool=new Pool({connectionString:url.toString()});try{await run(pool)}finally{productionPool=(await import('../../db/client.ts')).pool;await productionPool.end();await pool.end()}}finally{await control.query(`DROP DATABASE IF EXISTS ${quote(name)}`);await control.end()}}

test('ICT-R17-001 production preview/confirm preserves omitted fields and computes parent changes',async()=>withDatabase(async pool=>{
  const project='11111111-1111-4111-8111-111111111111'
  await pool.query(`insert into projects(id,code,name,status) values($1,'ICT-TEST','ICT test','planning')`,[project])
  const {previewImplementationPlanChanges:preview,confirmImplementationPlanChanges:confirm}=await import('./project-import-change-service.ts')
  const fullHeaders=['wbsCode','name','vendor','ownerName']
  const first=await preview(project,'baseline.csv',csv(fullHeaders,[['1','父任务','原厂商','负责人'],['1.1','子任务','原厂商','负责人']]))
  assert.deepEqual(first.errors,[])
  assert.deepEqual(first.items.map(item=>item.sourceRow),[2,3])
  await confirm(project,first.batch.id,{previewFingerprint:first.batch.previewFingerprint,baseBatchId:first.batch.baseBatchId,confirmCriticalChanges:true})
  await pool.query(`update tasks set progress=30,priority='high' where project_id=$1 and wbs_code='1.1'`,[project])
  const childBefore=(await pool.query(`select id,vendor,owner_name,status,progress,priority,parent_id from tasks where project_id=$1 and wbs_code='1.1'`,[project])).rows[0]
  const omitted=await preview(project,'omitted.csv',csv(['wbsCode','name'],[['1','父任务'],['1.1','子任务']]))
  assert.equal(omitted.items.find(x=>x.businessKey==='1.1')?.changes.some(x=>x.fieldKey==='parentWbsCode'),false)
  await confirm(project,omitted.batch.id,{previewFingerprint:omitted.batch.previewFingerprint,baseBatchId:omitted.batch.baseBatchId,confirmCriticalChanges:true})
  assert.deepEqual((await pool.query(`select vendor,owner_name,status,progress,priority,parent_id from tasks where id=$1`,[childBefore.id])).rows[0],{vendor:'原厂商',owner_name:'负责人',status:'not_started',progress:30,priority:'high',parent_id:childBefore.parent_id})
  const changed=await preview(project,'changed.csv',csv(['wbsCode','name','vendor'],[['1','父任务','原厂商'],['2','新父任务',''],['2.1','子任务','']]))
  const moved=changed.items.find(x=>x.businessKey==='2.1')
  assert.equal(moved?.changes.some(x=>x.fieldKey==='parentWbsCode'&&x.newValue==='2'),true)
  await assert.rejects(confirm(project,changed.batch.id,{previewFingerprint:changed.batch.previewFingerprint,baseBatchId:changed.batch.baseBatchId,confirmCriticalChanges:false}),/import_critical_changes_confirmation_required/)
  assert.equal((await pool.query(`select status from import_batches where id=$1`,[changed.batch.id])).rows[0].status,'previewed')
  assert.equal(Number((await pool.query(`select count(*) n from audit_logs where entity_id=$1 and action='import.failed'`,[changed.batch.id])).rows[0].n),0)
  await confirm(project,changed.batch.id,{previewFingerprint:changed.batch.previewFingerprint,baseBatchId:changed.batch.baseBatchId,confirmCriticalChanges:true})
  const rows=await pool.query(`select id,wbs_code,vendor,status,progress,priority,parent_id from tasks where project_id=$1 and is_current=true order by wbs_code`,[project])
  const newParent=rows.rows.find(x=>x.wbs_code==='2'),newChild=rows.rows.find(x=>x.wbs_code==='2.1')
  assert.equal(newChild.vendor,null);assert.equal(newChild.parent_id,newParent.id)
  assert.deepEqual({status:newParent.status,progress:newParent.progress,priority:newParent.priority},{status:'not_started',progress:0,priority:'medium'})
}))

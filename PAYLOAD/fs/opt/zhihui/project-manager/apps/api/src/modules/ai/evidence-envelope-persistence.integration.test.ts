import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { Pool } from 'pg'

const source=process.env.DATABASE_URL??''
const parsed=new URL(source)
if(!['127.0.0.1','localhost'].includes(parsed.hostname))throw new Error('integration_db_guard_non_local')
const admin=new URL(source);admin.pathname='/postgres'
const quote=(value:string)=>`"${value.replaceAll('"','""')}"`

async function isolated(run:(pool:Pool,url:string)=>Promise<void>){
  const name=`kb_evidence_${process.pid}_${Date.now()}`;const url=new URL(source);url.pathname=`/${name}`
  const control=new Pool({connectionString:admin.toString()});let pool:Pool|undefined
  try{await control.query(`CREATE DATABASE ${quote(name)}`);execFileSync('pnpm',['db:migrate'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:url.toString()},stdio:'pipe'});pool=new Pool({connectionString:url.toString()});await run(pool,url.toString())}
  finally{await pool?.end();await control.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`).catch(()=>undefined);await control.end()}
}

const ids={project:'11111111-1111-4111-8111-111111111111',document:'22222222-2222-4222-8222-222222222222',version:'33333333-3333-4333-8333-333333333333',chunk:'44444444-4444-4444-8444-444444444444'}

async function seed(pool:Pool){
  await pool.query(`insert into projects(id,code,name,status) values($1,'PRJ-EVIDENCE','Evidence','planning')`,[ids.project])
  const kb=(await pool.query(`insert into knowledge_bases(project_id,name,scope) values($1,'KB','project') returning id`,[ids.project])).rows[0].id
  await pool.query(`insert into documents(id,knowledge_base_id,project_id,name,original_name,file_type,status,checksum) values($1,$2,$3,'验收报告','a.pdf','pdf','confirmed','docsum')`,[ids.document,kb,ids.project])
  await pool.query(`insert into document_versions(id,document_id,version_number,storage_key,checksum,is_current) values($1,$2,'v2.1','test/key','versum',true)`,[ids.version,ids.document])
  await pool.query(`insert into document_chunks(id,document_id,version_id,chunk_index,content,token_count,embedding) values($1,$2,$3,7,'通过验收',4,array_fill(0::real,array[1024])::vector)`,[ids.chunk,ids.document,ids.version])
}

function vectorDigest(pool:Pool){return pool.query(`select count(*)::int n,md5(string_agg(id::text||':'||coalesce(embedding::text,''),'|' order by id)) hash from document_chunks`).then(r=>r.rows[0])}

test('0022 replays safely, preserves existing snapshots and leaves embeddings byte-stable',async()=>isolated(async(pool,url)=>{
  await seed(pool);const before=await vectorDigest(pool)
  const message=(await pool.query(`insert into ai_conversations(project_id,title) values($1,'t') returning id`,[ids.project])).rows[0].id
  const msg=(await pool.query(`insert into ai_messages(conversation_id,role,status,content,sequence) values($1,'assistant','completed','x',1) returning id`,[message])).rows[0].id
  await pool.query(`insert into ai_citations(message_id,document_id,version_id,chunk_id,sort_order,snippet,source_project_code,checksum) values($1,$2,$3,$4,0,'x','KEEP','KEEP-SUM')`,[msg,ids.document,ids.version,ids.chunk])
  const sql=(await import('node:fs/promises')).readFile(new URL('../../../../../database/migrations/0022_evidence_envelope_citations.sql',import.meta.url),'utf8')
  for(const statement of (await sql).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await pool.query(statement)
  for(const statement of (await sql).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await pool.query(statement)
  const row=(await pool.query(`select source_project_id,source_project_code,version_number,chunk_index,checksum,captured_at from ai_citations where message_id=$1`,[msg])).rows[0]
  assert.equal(row.source_project_id,ids.project);assert.equal(row.source_project_code,'KEEP');assert.equal(row.version_number,'v2.1');assert.equal(row.chunk_index,7);assert.equal(row.checksum,'KEEP-SUM');assert.ok(row.captured_at)
  assert.deepEqual(await vectorDigest(pool),before)

  process.env.DATABASE_URL=url
  const service=await import('./ai-conversation-service.ts')
  const citation={sourceProjectId:ids.project,sourceProjectCode:'PRJ-EVIDENCE',documentId:ids.document,versionId:ids.version,versionNumber:'v2.1',chunkId:ids.chunk,chunkIndex:7,checksum:'versum',capturedAt:'2026-09-17T01:02:03.000Z',snippet:'通过验收',pageNumber:2,sectionPath:'结论',score:.95}
  const sync=await service.completeProjectAiAnswer(ids.project,message,{content:'同步【文档:1】',citations:[citation]})
  const placeholder=await service.createProjectAiMessage(ids.project,message,{role:'assistant',status:'processing',content:'处理中'})
  assert.ok(placeholder)
  await service.finalizeProjectAiStreamAnswer(ids.project,message,placeholder!.id,{content:'流式【文档:1】',citations:[citation],metadata:{},harnessEventSeq:1,lastEventSeq:1})
  const replay=await service.listProjectAiMessages(ids.project,message,{limit:'20'})
  const snapshots=replay!.items.filter(item=>item.id===sync!.id||item.id===placeholder!.id).map(item=>item.citations[0]).sort((a,b)=>String(a.messageId).localeCompare(String(b.messageId)))
  assert.equal(snapshots.length,2)
  for(const snapshot of snapshots){assert.equal(snapshot.sourceProjectId,citation.sourceProjectId);assert.equal(snapshot.sourceProjectCode,citation.sourceProjectCode);assert.equal(snapshot.versionNumber,citation.versionNumber);assert.equal(snapshot.chunkIndex,citation.chunkIndex);assert.equal(snapshot.checksum,citation.checksum);assert.equal(new Date(snapshot.capturedAt).toISOString(),citation.capturedAt)}
  assert.deepEqual({...snapshots[0],id:undefined,messageId:undefined},{...snapshots[1],id:undefined,messageId:undefined})

  const legacyMessage=(await pool.query(`insert into ai_messages(conversation_id,role,status,content,sequence) values($1,'assistant','completed','旧引用',99) returning id`,[message])).rows[0].id
  await pool.query(`alter table ai_citations alter column captured_at drop not null`)
  await pool.query(`insert into ai_citations(message_id,document_id,version_id,chunk_id,sort_order,snippet,page_number,section_path,score,source_project_id,source_project_code,version_number,chunk_index,checksum,captured_at) values($1,$2,$3,$4,0,'旧片段',3,'旧章节',0.8,null,null,null,null,null,null)`,[legacyMessage,ids.document,ids.version,ids.chunk])
  const legacyReplay=await service.listProjectAiMessages(ids.project,message,{limit:'100'})
  const legacy=legacyReplay!.items.find(item=>item.id===legacyMessage)!.citations[0]!
  assert.equal(legacy.sourceProjectId,ids.project)
  assert.equal(legacy.sourceProjectCode,'PRJ-EVIDENCE')
  assert.equal(legacy.versionNumber,'v2.1')
  assert.equal(legacy.chunkIndex,7)
  assert.equal(legacy.checksum,'versum')
  assert.ok(legacy.capturedAt)

  await (await import('../../db/client.ts')).pool.end()
  assert.ok(url.includes('kb_evidence_'))
}))

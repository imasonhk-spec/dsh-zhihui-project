import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, importBatchEntities, importBatches, importFieldChanges, importJobs, projectPhases, projects, tasks } from '../../db/schema.ts'
import { previewImport, type ImportRow } from './import-service.ts'
import { requireImportChangeTrackingEnabled } from './import-change-feature.ts'

const VERSION = 'ICT-1'
const KIND = 'implementation_plan'
const SHEET = '详细实施计划（WBS分解）'
const severities = ['info', 'low', 'medium', 'high', 'critical'] as const
type Severity = typeof severities[number]
type ChangeType = 'initial'|'unchanged'|'created'|'modified'|'cleared'|'archived'
type Direction = 'increase'|'decrease'|'postponed'|'advanced'|'from_empty'|'to_empty'|'state_forward'|'state_backward'|'changed'|'none'
type NormalizedTask = Record<string, string|number|boolean|null>
type PreviewChange = { fieldKey:string; changeType:Exclude<ChangeType,'unchanged'>; direction:Direction; severity:Severity; oldValue:unknown; newValue:unknown; oldDisplay:string|null; newDisplay:string|null }
type PreviewItem = { businessKey:string; entityId:string|null; sourceSheet:string|null; sourceRow:number|null; raw:Record<string,unknown>; normalized:NormalizedTask; rowHash:string; changeType:ChangeType; maxSeverity:Severity; changes:PreviewChange[]; errors:string[] }
type Summary = { total:number; created:number; modified:number; unchanged:number; cleared:number; archived:number; invalid:number; hasChanges:boolean; maxSeverity:Severity; bySeverity:Record<Severity,number> }

const trackedFields = ['name','phaseName','description','vendor','ownerName','plannedStartDate','plannedEndDate','status','progress','priority','deliverable','parentWbsCode'] as const
const dateFields = new Set(['plannedStartDate','plannedEndDate'])
const numericFields = new Set(['progress'])
const highFields = new Set(['name','phaseName','ownerName','plannedStartDate','status','progress'])
const criticalFields = new Set(['plannedEndDate','isCurrent'])
const stateOrder = ['not_started','ready','in_progress','delayed','blocked','completed','closed','cancelled']

export function normalizeParentWbsCode(value:unknown):string|null { const normalized=normalizeKey(String(value??'')); return normalized||null }
export function taskUpdatePatch(value:NormalizedTask){const patch:Record<string,unknown>={};if('phaseName' in value)patch.phaseName=value.phaseName;if('name' in value)patch.name=String(value.name);for(const field of ['description','vendor','ownerName','plannedStartDate','plannedEndDate','status','progress','priority','deliverable'] as const)if(field in value)patch[field]=value[field];return patch}

export async function previewImplementationPlanChanges(projectId:string, sourceName:string, body:Buffer, actor:{actorId?:string;actorName?:string;requestId?:string}={}) {
  requireImportChangeTrackingEnabled()
  assertUuid(projectId, 'project_id_invalid')
  const parsed = await previewImport(projectId, 'tasks', sourceName, body)
  const duplicate = new Map<string,number>()
  const errors = [...parsed.errors]
  const normalizedRows: Array<{row:ImportRow; value:NormalizedTask; rowNumber:number}> = []
  for (const row of parsed.rows) {
    const rowNumber = Number(row.__sourceRow) || 0
    try {
      const value = normalizeTask(row, new Set(parsed.headers))
      let key = String(value.wbsCode)
      if (duplicate.has(key)) {
        // Legacy workbooks may repeat a WBS number in a later section. Keep
        // both tasks with a deterministic row suffix rather than rejecting the
        // complete implementation-plan snapshot.
        key = `${key}-R${rowNumber}`
        value.wbsCode = key
        value.parentWbsCode = normalizeParentWbsCode(key.split('.').length > 1 ? key.split('.').slice(0, -1).join('.') : null)
      }
      duplicate.set(key, rowNumber)
      normalizedRows.push({ row, value, rowNumber })
    } catch (error) { errors.push({ row:rowNumber, message:error instanceof Error ? error.message : 'import_row_invalid' }) }
  }
  if (!normalizedRows.length && !errors.length) errors.push({ message:'import_task_snapshot_empty' })

  const [project] = await db.select({ id:projects.id }).from(projects).where(eq(projects.id,projectId)).limit(1)
  if (!project) throw new Error('project_not_found')
  const [base] = await db.select().from(importBatches).where(and(eq(importBatches.app,'project'),eq(importBatches.scopeId,projectId),eq(importBatches.kind,KIND),eq(importBatches.status,'succeeded'))).orderBy(desc(importBatches.appliedAt),desc(importBatches.createdAt)).limit(1)
  const currentTasks = await db.select().from(tasks).where(and(eq(tasks.projectId,projectId),eq(tasks.isCurrent,true)))
  const phases = await db.select().from(projectPhases).where(eq(projectPhases.projectId,projectId))
  const phaseNames = new Map(phases.map(p=>[p.id,p.name]))
  const wbsByTaskId = new Map(currentTasks.map(task=>[task.id,normalizeKey(task.wbsCode)]))
  const existing = new Map(currentTasks.map(task=>[normalizeKey(task.wbsCode), { task, value: taskValue(task, phaseNames.get(task.phaseId ?? '') ?? null, task.parentId ? wbsByTaskId.get(task.parentId) ?? null : null) }]))
  const items:PreviewItem[]=[]
  for (const entry of normalizedRows) {
    const businessKey=String(entry.value.wbsCode)
    const prior=existing.get(businessKey)
    existing.delete(businessKey)
    const changes:PreviewChange[]=[]
    let changeType:ChangeType
    if (!base) {
      changeType='initial'
      for (const fieldKey of trackedFields) if (entry.value[fieldKey] != null) changes.push(makeChange(fieldKey,'initial',null,entry.value[fieldKey],prior?.task.status))
    } else if (!prior) {
      changeType='created'
      for (const fieldKey of trackedFields) if (entry.value[fieldKey] != null) changes.push(makeChange(fieldKey,'created',null,entry.value[fieldKey]))
    } else {
      for (const fieldKey of trackedFields) {
        if (!(fieldKey in entry.value)) continue
        const oldValue=prior.value[fieldKey] ?? null, newValue=entry.value[fieldKey] ?? null
        if (equalValue(oldValue,newValue)) continue
        changes.push(makeChange(fieldKey,newValue===null?'cleared':'modified',oldValue,newValue,prior.task.status))
      }
      changeType=changes.some(c=>c.changeType==='cleared')?'cleared':changes.length?'modified':'unchanged'
    }
    const rowHash=hash(stableJson(entry.value))
    items.push({businessKey,entityId:prior?.task.id??null,sourceSheet:SHEET,sourceRow:entry.rowNumber,raw:entry.row,normalized:entry.value,rowHash,changeType,maxSeverity:maxSeverity(changes),changes,errors:[]})
  }
  if (base) for (const [businessKey,prior] of existing) {
    const change=makeChange('isCurrent','archived',true,false,prior.task.status)
    items.push({businessKey,entityId:prior.task.id,sourceSheet:null,sourceRow:null,raw:{},normalized:{...prior.value,isCurrent:false},rowHash:hash(stableJson(prior.value)),changeType:'archived',maxSeverity:'critical',changes:[change],errors:[]})
  }
  const summary=summarize(items,errors.length)
  const sourceChecksum=hash(body)
  const previewFingerprint=hash(stableJson({rows:normalizedRows.map(r=>r.value).sort((a,b)=>String(a.wbsCode).localeCompare(String(b.wbsCode))),baseBatchId:base?.id??null,mappingVersion:VERSION,normalizationVersion:VERSION}))
  const [batch]=await db.insert(importBatches).values({app:'project',scopeType:'project',scopeId:projectId,kind:KIND,mode:'snapshot',sourceName,sourceChecksum,mappingVersion:VERSION,normalizationVersion:VERSION,baseBatchId:base?.id??null,previewFingerprint,status:'previewed',counts:{...summary,confirmable:errors.length===0,errors,previewItems:items},...actor}).returning()
  await db.insert(auditLogs).values({projectId,entityType:'import_batch',entityId:batch.id,action:'import.previewed',actorName:actor.actorName??'system',changes:{batchId:batch.id,baseBatchId:base?.id??null,sourceChecksum,mappingVersion:VERSION,normalizationVersion:VERSION,counts:summary,requestId:actor.requestId}})
  return response(batch,summary,items,errors)
}

export async function confirmImplementationPlanChanges(projectId:string,batchId:string,input:{previewFingerprint?:string;baseBatchId?:string|null;confirmCriticalChanges?:boolean;actorId?:string;actorName?:string;requestId?:string}) {
  requireImportChangeTrackingEnabled()
  assertUuid(projectId,'project_id_invalid'); assertUuid(batchId,'import_batch_id_invalid')
  let result:Awaited<ReturnType<typeof applyImplementationPlanConfirmation>>
  try { result=await db.transaction(tx=>applyImplementationPlanConfirmation(tx,projectId,batchId,input)) }
  catch(error){const code=error instanceof Error?error.message:'import_confirm_failed';if(code!=='import_critical_changes_confirmation_required'){await db.update(importBatches).set({status:'failed',updatedAt:new Date()}).where(and(eq(importBatches.id,batchId),eq(importBatches.scopeId,projectId),eq(importBatches.status,'previewed')));await db.insert(auditLogs).values({projectId,entityType:'import_batch',entityId:batchId,action:'import.failed',actorName:input.actorName??'system',changes:{batchId,baseBatchId:input.baseBatchId??null,requestId:input.requestId,error:code}})}throw error}
  return {batch:batchView(result.batch),summary:result.summary,idempotent:result.idempotent}
}

async function applyImplementationPlanConfirmation(tx:Parameters<Parameters<typeof db.transaction>[0]>[0],projectId:string,batchId:string,input:{previewFingerprint?:string;baseBatchId?:string|null;confirmCriticalChanges?:boolean;actorId?:string;actorName?:string;requestId?:string}) {
    await tx.execute(sql`select ${projects.id} from ${projects} where ${projects.id}=${projectId} for update`)
    const [batch]=await tx.select().from(importBatches).where(and(eq(importBatches.id,batchId),eq(importBatches.scopeId,projectId),eq(importBatches.app,'project'),eq(importBatches.kind,KIND))).limit(1)
    if(!batch) throw new Error('import_batch_not_found')
    const stored=batch.counts as Record<string,unknown>
    const summary=publicSummary(stored)
    if(input.previewFingerprint!==batch.previewFingerprint) throw new Error('import_preview_fingerprint_changed')
    if((input.baseBatchId??null)!==(batch.baseBatchId??null)) throw new Error('import_base_batch_changed')
    if(batch.status==='succeeded') return {batch,summary,idempotent:true}
    if(batch.status!=='previewed') throw new Error('import_batch_not_confirmable')
    const [currentBatch]=await tx.select({id:importBatches.id}).from(importBatches).where(and(eq(importBatches.app,'project'),eq(importBatches.scopeId,projectId),eq(importBatches.kind,KIND),eq(importBatches.status,'succeeded'))).orderBy(desc(importBatches.appliedAt),desc(importBatches.createdAt)).limit(1)
    if((currentBatch?.id??null)!==(batch.baseBatchId??null)) throw new Error('import_base_batch_changed')
    if(Number((summary.bySeverity as Record<string,number>).critical??0)>0&&!input.confirmCriticalChanges) throw new Error('import_critical_changes_confirmation_required')
    const errors=Array.isArray(stored.errors)?stored.errors:[]
    if(errors.length) throw new Error('import_batch_has_validation_errors')
    const items=(Array.isArray(stored.previewItems)?stored.previewItems:[]) as PreviewItem[]
    await tx.update(importBatches).set({status:'applying',updatedAt:new Date()}).where(eq(importBatches.id,batch.id))
    const now=new Date()
    const [job]=await tx.insert(importJobs).values({projectId,kind:'tasks',sourceName:batch.sourceName,status:'processing',totalRows:items.filter(i=>i.sourceRow!==null).length}).returning()
    const phaseRows=await tx.select().from(projectPhases).where(eq(projectPhases.projectId,projectId)).orderBy(asc(projectPhases.createdAt))
    const phasesByName=new Map<string,typeof phaseRows[number]>(); for(const p of phaseRows) if(!phasesByName.has(normalizeName(p.name))) phasesByName.set(normalizeName(p.name),p)
    const phaseIdByName=new Map<string,string>(); const currentPhaseIds=new Set<string>()
    const moduleNames=[...new Map(items.filter(i=>i.sourceRow!==null).map(i=>String(i.normalized.phaseName??'')).filter(Boolean).map(n=>[normalizeName(n),n])).values()]
    for(const [index,name] of moduleNames.entries()) { const key=normalizeName(name), prior=phasesByName.get(key); if(prior){await tx.update(projectPhases).set({name,isCurrent:true,snapshotId:job.id,archivedAt:null,sortOrder:index,updatedAt:now}).where(eq(projectPhases.id,prior.id));phaseIdByName.set(key,prior.id);currentPhaseIds.add(prior.id)}else{const [created]=await tx.insert(projectPhases).values({projectId,name,code:`IMP-${batch.id.slice(0,8)}-${String(index+1).padStart(2,'0')}`,sortOrder:index,status:'not_started',progress:0,isCurrent:true,snapshotId:job.id}).returning();phaseIdByName.set(key,created.id);currentPhaseIds.add(created.id)}}
    const archivePhases=phaseRows.filter(p=>p.isCurrent&&!currentPhaseIds.has(p.id)).map(p=>p.id); if(archivePhases.length) await tx.update(projectPhases).set({isCurrent:false,archivedAt:now,updatedAt:now}).where(inArray(projectPhases.id,archivePhases))
    const current=await tx.select().from(tasks).where(and(eq(tasks.projectId,projectId),eq(tasks.isCurrent,true))); const currentByKey=new Map(current.map(t=>[normalizeKey(t.wbsCode),t])); const taskIdByKey=new Map<string,string>()
    for(const item of items.filter(i=>i.sourceRow!==null)){const value=item.normalized, key=item.businessKey, prior=currentByKey.get(key); const common={isCurrent:true,snapshotId:job.id,archivedAt:null,updatedAt:now};const createValues={phaseId:phaseIdByName.get(normalizeName(String(value.phaseName??'')))??null,parentId:null,wbsCode:key,name:String(value.name),description:asNullable(value.description),vendor:asNullable(value.vendor),ownerName:asNullable(value.ownerName),plannedStartDate:asNullable(value.plannedStartDate),plannedEndDate:asNullable(value.plannedEndDate),status:String(value.status??'not_started') as typeof tasks.$inferInsert.status,progress:Number(value.progress??0),priority:String(value.priority??'medium') as typeof tasks.$inferInsert.priority,deliverable:asNullable(value.deliverable),...common}; if(prior){const updateValues:Partial<typeof createValues>={...common};if('phaseName' in value)updateValues.phaseId=phaseIdByName.get(normalizeName(String(value.phaseName??'')))??null;if('name' in value)updateValues.name=String(value.name);if('description' in value)updateValues.description=asNullable(value.description);if('vendor' in value)updateValues.vendor=asNullable(value.vendor);if('ownerName' in value)updateValues.ownerName=asNullable(value.ownerName);if('plannedStartDate' in value)updateValues.plannedStartDate=asNullable(value.plannedStartDate);if('plannedEndDate' in value)updateValues.plannedEndDate=asNullable(value.plannedEndDate);if('status' in value)updateValues.status=String(value.status) as typeof tasks.$inferInsert.status;if('progress' in value)updateValues.progress=Number(value.progress);if('priority' in value)updateValues.priority=String(value.priority) as typeof tasks.$inferInsert.priority;if('deliverable' in value)updateValues.deliverable=asNullable(value.deliverable);await tx.update(tasks).set(updateValues).where(eq(tasks.id,prior.id));taskIdByKey.set(key,prior.id)}else{const [created]=await tx.insert(tasks).values({projectId,...createValues}).returning({id:tasks.id});taskIdByKey.set(key,created.id)} }
    for(const [key,taskId] of taskIdByKey){let parts=key.split('.'),parentId:string|null=null;while(parts.length>1&&!parentId){parts=parts.slice(0,-1);parentId=taskIdByKey.get(parts.join('.'))??null}await tx.update(tasks).set({parentId}).where(eq(tasks.id,taskId))}
    const archived=items.filter(i=>i.changeType==='archived').map(i=>i.entityId).filter((id):id is string=>Boolean(id)); if(archived.length) await tx.update(tasks).set({isCurrent:false,archivedAt:now,updatedAt:now}).where(and(eq(tasks.projectId,projectId),inArray(tasks.id,archived)))
    for(const item of items){const targetEntityId=taskIdByKey.get(item.businessKey)??item.entityId;const [entity]=await tx.insert(importBatchEntities).values({batchId:batch.id,entityType:'task',businessKey:item.businessKey,targetEntityId,sourceSheet:item.sourceSheet,sourceRow:item.sourceRow,raw:item.raw,normalized:item.normalized,rowHash:item.rowHash,changeType:item.changeType,maxSeverity:item.maxSeverity,changedFieldCount:item.changes.length}).returning();if(item.changeType!=='unchanged')for(const change of item.changes)await tx.insert(importFieldChanges).values({batchId:batch.id,batchEntityId:entity.id,entityType:'task',businessKey:item.businessKey,targetEntityId,fieldKey:change.fieldKey,changeType:change.changeType,direction:change.direction,severity:change.severity,oldValue:change.oldValue as never,newValue:change.newValue as never,oldDisplay:change.oldDisplay,newDisplay:change.newDisplay})}
    const progressItems=items.filter(i=>i.sourceRow!==null);const overall=progressItems.length?Math.round(progressItems.reduce((s,i)=>s+Number(i.normalized.progress??0),0)/progressItems.length):0
    const [project]=await tx.select().from(projects).where(eq(projects.id,projectId)).limit(1);await tx.update(projects).set({progress:overall,metadata:{...(project?.metadata??{}),currentTaskSnapshotId:batch.id,currentTaskSnapshotSource:batch.sourceName,currentTaskSnapshotAt:now.toISOString()},updatedAt:now}).where(eq(projects.id,projectId))
    await tx.update(importJobs).set({status:'completed',successRows:progressItems.length,failedRows:0,updatedAt:now}).where(eq(importJobs.id,job.id))
    const [completed]=await tx.update(importBatches).set({status:'succeeded',counts:summary,actorId:input.actorId??batch.actorId,actorName:input.actorName??batch.actorName,requestId:input.requestId??batch.requestId,appliedAt:now,updatedAt:now}).where(eq(importBatches.id,batch.id)).returning()
    await tx.insert(auditLogs).values({projectId,entityType:'import_batch',entityId:batch.id,action:'import.confirmed',actorName:input.actorName??batch.actorName??'system',changes:{batchId:batch.id,baseBatchId:batch.baseBatchId,sourceChecksum:batch.sourceChecksum,mappingVersion:VERSION,normalizationVersion:VERSION,counts:summary,requestId:input.requestId??batch.requestId}})
    return {batch:completed,summary,idempotent:false}
}

export async function listImplementationPlanBatchChanges(projectId:string,batchId:string,filters:{entityKey?:string;severity?:string;changeType?:string;page?:string}) { assertUuid(projectId,'project_id_invalid');const [batch]=await db.select().from(importBatches).where(and(eq(importBatches.id,batchId),eq(importBatches.scopeId,projectId),eq(importBatches.app,'project'))).limit(1);if(!batch)throw new Error('import_batch_not_found');let rows=await db.select().from(importBatchEntities).where(eq(importBatchEntities.batchId,batchId)).orderBy(asc(importBatchEntities.businessKey));if(filters.entityKey)rows=rows.filter(r=>r.businessKey===normalizeKey(filters.entityKey!));if(filters.severity)rows=rows.filter(r=>r.maxSeverity===filters.severity);if(filters.changeType)rows=rows.filter(r=>r.changeType===filters.changeType);const page=Math.max(1,Number(filters.page)||1),pageSize=50,slice=rows.slice((page-1)*pageSize,page*pageSize);const changes=slice.length?await db.select().from(importFieldChanges).where(inArray(importFieldChanges.batchEntityId,slice.map(r=>r.id))).orderBy(asc(importFieldChanges.createdAt)):[];return {batch:batchView(batch),items:slice.map(entity=>({...entity,raw:undefined,changes:changes.filter(c=>c.batchEntityId===entity.id).map(changeView)})),page,pageSize,total:rows.length} }
export async function listImplementationPlanEntityChanges(projectId:string,entityId:string,limit=20){assertUuid(projectId,'project_id_invalid');assertUuid(entityId,'entity_id_invalid');const [task]=await db.select({id:tasks.id}).from(tasks).where(and(eq(tasks.id,entityId),eq(tasks.projectId,projectId))).limit(1);if(!task)throw new Error('entity_not_found');const rows=await db.select({change:importFieldChanges,batch:importBatches}).from(importFieldChanges).innerJoin(importBatches,eq(importFieldChanges.batchId,importBatches.id)).where(and(eq(importFieldChanges.targetEntityId,entityId),eq(importBatches.scopeId,projectId))).orderBy(desc(importFieldChanges.createdAt)).limit(Math.max(1,Math.min(100,limit)));return rows.map(r=>({...changeView(r.change),batch:batchView(r.batch)}))}
export async function latestImplementationPlanChangeMarkers(projectId:string){const [batch]=await db.select().from(importBatches).where(and(eq(importBatches.scopeId,projectId),eq(importBatches.kind,KIND),eq(importBatches.status,'succeeded'))).orderBy(desc(importBatches.appliedAt)).limit(1);if(!batch)return [];const entities=await db.select().from(importBatchEntities).where(eq(importBatchEntities.batchId,batch.id));const fields=entities.length?await db.select().from(importFieldChanges).where(inArray(importFieldChanges.batchEntityId,entities.map(e=>e.id))):[];return entities.filter(e=>e.targetEntityId&&['created','modified','cleared'].includes(e.changeType)).map(e=>({entityId:e.targetEntityId,latestImportChange:{batchId:batch.id,changedAt:batch.appliedAt?.toISOString()??batch.updatedAt.toISOString(),changeType:e.changeType,changedFieldCount:e.changedFieldCount,maxSeverity:e.maxSeverity,fields:fields.filter(f=>f.batchEntityId===e.id).map(f=>f.fieldKey)}}))}

function normalizeTask(row:ImportRow,headers:Set<string>):NormalizedTask {const wbsCode=normalizeKey(row.wbsCode??'');if(!wbsCode)throw new Error('import_task_wbs_required');const name=normalizeText(row.name);if(!name)throw new Error('task_name_required');const value:NormalizedTask={wbsCode,name};for(const key of trackedFields){if(key==='name'||!headers.has(key))continue;const raw=row[key];if(key==='progress'){const n=raw===''?null:Number(raw);if(n!==null&&(!Number.isFinite(n)||n<0||n>100))throw new Error('task_progress_invalid');value[key]=n}else if(dateFields.has(key)){value[key]=raw===''?null:normalizeDate(raw)}else value[key]=raw===''?null:normalizeText(raw)}const parts=wbsCode.split('.');value.parentWbsCode=normalizeParentWbsCode(parts.length>1?parts.slice(0,-1).join('.'):null);if(value.status==='completed'&&value.progress!==undefined&&value.progress!==100)throw new Error('completed_task_requires_100_progress');return value}
function taskValue(task:typeof tasks.$inferSelect,phaseName:string|null,parentWbsCode:string|null):NormalizedTask{return {wbsCode:normalizeKey(task.wbsCode),name:normalizeText(task.name),phaseName:phaseName?normalizeText(phaseName):null,description:task.description?normalizeMultiline(task.description):null,vendor:task.vendor?normalizeText(task.vendor):null,ownerName:task.ownerName?normalizeText(task.ownerName):null,plannedStartDate:task.plannedStartDate,plannedEndDate:task.plannedEndDate,status:task.status,progress:task.progress,priority:task.priority,deliverable:task.deliverable?normalizeMultiline(task.deliverable):null,parentWbsCode:normalizeParentWbsCode(parentWbsCode),isCurrent:task.isCurrent}}
function makeChange(fieldKey:string,changeType:PreviewChange['changeType'],oldValue:unknown,newValue:unknown,oldStatus?:string):PreviewChange{let direction:Direction='changed';if(changeType==='initial')direction='none';else if(oldValue==null&&newValue!=null)direction='from_empty';else if(oldValue!=null&&newValue==null)direction='to_empty';else if(dateFields.has(fieldKey))direction=String(newValue)>String(oldValue)?'postponed':'advanced';else if(numericFields.has(fieldKey))direction=Number(newValue)>Number(oldValue)?'increase':'decrease';else if(fieldKey==='status'){const a=stateOrder.indexOf(String(oldValue)),b=stateOrder.indexOf(String(newValue));direction=b>=a?'state_forward':'state_backward'}let severity:Severity=criticalFields.has(fieldKey)?'critical':highFields.has(fieldKey)?'high':'medium';if(changeType==='initial')severity='info';else if(changeType==='archived'||(changeType==='cleared'&&criticalFields.has(fieldKey)))severity='critical';else if(fieldKey==='plannedEndDate'&&direction==='postponed'){const days=(Date.parse(String(newValue))-Date.parse(String(oldValue)))/86400000;severity=days>7?'high':'medium'}else if(fieldKey==='status'&&direction==='state_forward')severity='low';else if(fieldKey==='progress'&&direction==='increase')severity='low';else if(fieldKey==='progress'&&direction==='decrease')severity='high';else if(changeType==='cleared'&&fieldKey==='ownerName')severity='high';else if(oldStatus==='completed'&&dateFields.has(fieldKey))severity='high';return {fieldKey,changeType,direction,severity,oldValue,newValue,oldDisplay:display(oldValue),newDisplay:display(newValue)}}
function summarize(items:PreviewItem[],invalid:number):Summary{const summary:Summary={total:items.length,created:0,modified:0,unchanged:0,cleared:0,archived:0,invalid,hasChanges:false,maxSeverity:'info',bySeverity:{info:0,low:0,medium:0,high:0,critical:0}};for(const item of items){if(item.changeType!=='initial')summary[item.changeType]+=1;for(const c of item.changes)summary.bySeverity[c.severity]+=1}summary.hasChanges=summary.created+summary.modified+summary.cleared+summary.archived>0;summary.maxSeverity=maxSeverity(items.flatMap(i=>i.changes));return summary}
function response(batch:typeof importBatches.$inferSelect,summary:Summary,items:PreviewItem[],errors:unknown[]){return {batch:{...batchView(batch),baseline:batch.baseBatchId===null},summary,items:items.map(({raw:_,normalized:__,rowHash:___,...item})=>item),errors,confirmable:errors.length===0}}
function batchView(batch:typeof importBatches.$inferSelect){return {id:batch.id,app:batch.app,scopeId:batch.scopeId,kind:batch.kind,mode:batch.mode,baseBatchId:batch.baseBatchId,previewFingerprint:batch.previewFingerprint,mappingVersion:batch.mappingVersion,normalizationVersion:batch.normalizationVersion,status:batch.status,sourceName:batch.sourceName,sourceChecksum:batch.sourceChecksum,createdAt:batch.createdAt,appliedAt:batch.appliedAt}}
function changeView(c:typeof importFieldChanges.$inferSelect){return {fieldKey:c.fieldKey,changeType:c.changeType,direction:c.direction,severity:c.severity,oldValue:c.oldValue,newValue:c.newValue,oldDisplay:c.oldDisplay,newDisplay:c.newDisplay,derived:c.derived}}
function publicSummary(value:Record<string,unknown>):Summary{return {total:Number(value.total??0),created:Number(value.created??0),modified:Number(value.modified??0),unchanged:Number(value.unchanged??0),cleared:Number(value.cleared??0),archived:Number(value.archived??0),invalid:Number(value.invalid??0),hasChanges:Boolean(value.hasChanges),maxSeverity:(severities.includes(value.maxSeverity as Severity)?value.maxSeverity:'info') as Severity,bySeverity:(value.bySeverity??{info:0,low:0,medium:0,high:0,critical:0}) as Record<Severity,number>}}
function maxSeverity(changes:PreviewChange[]):Severity{return changes.reduce<Severity>((max,c)=>severities.indexOf(c.severity)>severities.indexOf(max)?c.severity:max,'info')}
function normalizeKey(v:string){return v.normalize('NFKC').trim()}
function normalizeName(v:string){return normalizeText(v).toLocaleLowerCase('zh-CN')}
function normalizeText(v:unknown){return String(v??'').normalize('NFKC').trim().replace(/\s+/g,' ')}
function normalizeMultiline(v:string){return v.normalize('NFKC').replace(/\r\n?/g,'\n').split('\n').map(x=>x.replace(/\s+$/g,'')).join('\n').trim()}
function normalizeDate(v:string){if(/^\d{4}-\d{2}-\d{2}$/.test(v))return v;throw new Error('import_date_invalid')}
function equalValue(a:unknown,b:unknown){return stableJson(a)===stableJson(b)}
function stableJson(v:unknown):string{if(Array.isArray(v))return `[${v.map(stableJson).join(',')}]`;if(v&&typeof v==='object')return `{${Object.entries(v as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${stableJson(x)}`).join(',')}}`;return JSON.stringify(v)}
function hash(v:string|Buffer){return createHash('sha256').update(v).digest('hex')}
function display(v:unknown){return v==null?null:String(v)}
function asNullable(v:unknown){return v==null?null:String(v)}
function assertUuid(v:string,code:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))throw new Error(code)}

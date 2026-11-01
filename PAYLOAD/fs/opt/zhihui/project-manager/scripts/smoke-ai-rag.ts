import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db,pool } from '../apps/api/src/db/client.ts'
import { aiCitations,aiMessages,coordinationItems,documentChunks,documents,documentVersions,knowledgeBases,milestones,projects,risks,tasks } from '../apps/api/src/db/schema.ts'
import { createProjectAiConversation } from '../apps/api/src/modules/ai/ai-conversation-service.ts'
import { answerProjectQuestion } from '../apps/api/src/modules/ai/rag-answer-service.ts'
import { buildProjectContext } from '../apps/api/src/modules/ai/project-context-service.ts'

const projectId=randomUUID(),otherProjectId=randomUUID(),baseId=randomUUID(),otherBaseId=randomUUID(),docId=randomUUID(),otherDocId=randomUUID(),versionId=randomUUID(),otherVersionId=randomUUID();let captured=''
try{
 await db.insert(projects).values([{id:projectId,code:`RAG-${projectId.slice(0,8)}`,name:'RAG项目A',clientName:'甲方哨兵A',progress:42},{id:otherProjectId,code:`RAG-${otherProjectId.slice(0,8)}`,name:'RAG项目B',description:'绝密毒标B'}])
 await db.insert(tasks).values({projectId,wbsCode:'1.1',name:'联调任务A',status:'in_progress',progress:60,priority:'high'})
 await db.insert(risks).values([{projectId,code:'RA',name:'活动风险A',status:'following'},{projectId,code:'RX',name:'已接受噪音',status:'accepted'}])
 await db.insert(milestones).values({projectId,name:'里程碑A',plannedDate:'2026-09-10'})
 await db.insert(coordinationItems).values([{projectId,code:'CA',category:'外部',title:'协调事项A',status:'communicating'},{projectId,code:'CX',category:'外部',title:'已解决噪音',status:'resolved'}])
 await db.insert(knowledgeBases).values([{id:baseId,projectId,name:'A库'},{id:otherBaseId,projectId:otherProjectId,name:'B库'}])
 await db.insert(documents).values([{id:docId,projectId,knowledgeBaseId:baseId,name:'A当前文档',originalName:'a.md',fileType:'md',status:'confirmed',parseStatus:'completed',indexStatus:'completed',aiEnabled:true},{id:otherDocId,projectId:otherProjectId,knowledgeBaseId:otherBaseId,name:'B秘密',originalName:'b.md',fileType:'md',status:'confirmed',parseStatus:'completed',indexStatus:'completed',aiEnabled:true}])
 await db.insert(documentVersions).values([{id:versionId,documentId:docId,versionNumber:'v2',storageKey:'smoke/a',isCurrent:true},{id:otherVersionId,documentId:otherDocId,versionNumber:'v1',storageKey:'smoke/b',isCurrent:true}])
 const [chunk]=await db.insert(documentChunks).values({documentId:docId,versionId,chunkIndex:0,content:'A项目当前版本证据：联调必须在里程碑前完成。',pageNumber:3,sectionPath:'计划/联调'}).returning()
 const conversation=await createProjectAiConversation(projectId,{title:'RAG验收'});await db.update((await import('../apps/api/src/db/schema.ts')).aiConversations).set({harnessSessionId:'fake-rag-session'}).where(eq((await import('../apps/api/src/db/schema.ts')).aiConversations.id,conversation.id))
 const context=await buildProjectContext(projectId);assert.ok(context.text.includes('甲方哨兵A'));assert.ok(context.text.includes('活动风险A'));assert.ok(!context.text.includes('已接受噪音'));assert.ok(!context.text.includes('绝密毒标B'));assert.ok(!context.text.includes('已解决噪音'))
 const search=async()=>({query:'联调',mode:'hybrid' as const,total:1,limit:8,offset:0,minScore:.45,items:[{chunkId:chunk.id,documentId:docId,documentName:'A当前文档',originalName:'a.md',fileType:'md',status:'confirmed',folderId:null,folderPath:null,versionId,versionNumber:'v2',chunkIndex:0,pageNumber:3,sectionPath:'计划/联调',snippet:'A项目当前版本证据',highlights:['联调'],semanticScore:.9,keywordRank:.5,score:.8,matchedBy:['semantic'],metadata:{},updatedAt:new Date()}]})
 const harness={promptAndWait:async(_session:string,prompt:string)=>{captured=prompt;return{text:'结论：联调需在里程碑前完成【文档:1】【业务:task:'+projectId+'】',lastEventSeq:10,turnReason:'completed'}}} as any
 const result=await answerProjectQuestion(projectId,conversation.id,'联调要求是什么',{harness,search:search as any});assert.equal(result?.retrieval.evidenceCount,1);assert.ok(captured.includes('A当前文档'));assert.ok(captured.includes('甲方哨兵A'));assert.ok(!captured.includes('绝密毒标B'))
 const [assistant]=await db.select().from(aiMessages).where(eq(aiMessages.id,result!.assistantMessage!.id));assert.equal(assistant.status,'completed');const citations=await db.select().from(aiCitations).where(eq(aiCitations.messageId,assistant.id));assert.equal(citations.length,1);assert.ok(result?.assistantMessage?.citations?.[0]?.id);assert.equal(citations[0]?.versionId,versionId);assert.equal(citations[0]?.chunkId,chunk.id);assert.equal(citations[0]?.pageNumber,3)
 const emptyConversation=await createProjectAiConversation(projectId,{title:'无文档证据'});await db.update((await import('../apps/api/src/db/schema.ts')).aiConversations).set({harnessSessionId:'fake-empty'}).where(eq((await import('../apps/api/src/db/schema.ts')).aiConversations.id,emptyConversation.id));captured='';const emptySearch=async()=>({query:'未知',mode:'hybrid' as const,total:0,limit:8,offset:0,minScore:.45,items:[]});const empty=await answerProjectQuestion(projectId,emptyConversation.id,'没有文档时呢',{harness,search:emptySearch as any});assert.equal(empty?.retrieval.evidenceCount,0);assert.equal(empty?.assistantMessage?.metadata.answerMode,'business_context');assert.equal((await db.select().from(aiCitations).where(eq(aiCitations.messageId,empty!.assistantMessage!.id))).length,0);assert.ok(captured.includes('没有命中的当前项目知识文档'))
 console.log(JSON.stringify({ok:true,projectIsolation:true,businessContext:true,currentVersionCitation:true,atomicCitationPersistence:true,noDocumentEvidence:true}))
}finally{await db.delete(projects).where(eq(projects.id,projectId)).catch(()=>undefined);await db.delete(projects).where(eq(projects.id,otherProjectId)).catch(()=>undefined);await pool.end()}

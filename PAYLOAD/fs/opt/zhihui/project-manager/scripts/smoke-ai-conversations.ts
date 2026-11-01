import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../apps/api/src/db/client.ts'
import { projects } from '../apps/api/src/db/schema.ts'
import { createProjectAiConversation, createProjectAiMessage, deleteProjectAiConversation, getProjectAiConversation, listProjectAiMessages } from '../apps/api/src/modules/ai/ai-conversation-service.ts'

const projectId=randomUUID(),otherProjectId=randomUUID()
try{
  await db.insert(projects).values([{id:projectId,code:`AI-${projectId.slice(0,8)}`,name:'AI会话验收'},{id:otherProjectId,code:`AI-${otherProjectId.slice(0,8)}`,name:'隔离项目'}])
  const conversation=await createProjectAiConversation(projectId,{title:'11.1验收会话'})
  assert.equal(await getProjectAiConversation(otherProjectId,conversation.id),undefined)
  const first=await createProjectAiMessage(projectId,conversation.id,{role:'user',content:'第一条消息'})
  const second=await createProjectAiMessage(projectId,conversation.id,{role:'assistant',content:'第二条消息',status:'processing'})
  assert.equal(first?.sequence,1);assert.equal(second?.sequence,2)
  const page=await listProjectAiMessages(projectId,conversation.id,{limit:'1'});assert.equal(page?.items.length,1);assert.equal(page?.items[0]?.sequence,2);assert.equal(page?.hasMore,true)
  const older=await listProjectAiMessages(projectId,conversation.id,{limit:'10',before:'2'});assert.deepEqual(older?.items.map(item=>item.sequence),[1])
  assert.equal(await listProjectAiMessages(otherProjectId,conversation.id),undefined)
  assert.equal(await deleteProjectAiConversation(otherProjectId,conversation.id),false)
  assert.equal(await deleteProjectAiConversation(projectId,conversation.id),true)
  assert.equal(await getProjectAiConversation(projectId,conversation.id),undefined)
  console.log(JSON.stringify({ok:true,projectIsolation:true,stableSequence:true,pagination:true,deleteCascade:true}))
}finally{await db.delete(projects).where(eq(projects.id,projectId)).catch(()=>undefined);await db.delete(projects).where(eq(projects.id,otherProjectId)).catch(()=>undefined);await pool.end()}

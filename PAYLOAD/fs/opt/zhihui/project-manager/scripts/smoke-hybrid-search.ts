import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, pool } from '../apps/api/src/db/client.ts'
import { documentChunks, documents, documentVersions, knowledgeBases, projects } from '../apps/api/src/db/schema.ts'
import { EMBEDDING_MODEL, checkEmbeddingProvider, embedTexts } from '../apps/api/src/infrastructure/embedding-client.ts'
import { embedProjectDocumentVersion } from '../apps/api/src/modules/knowledge/embedding-service.ts'
import { searchProjectKnowledgeHybrid } from '../apps/api/src/modules/knowledge/hybrid-search-service.ts'

const projectId=randomUUID(),otherProject=randomUUID(),baseId=randomUUID(),otherBase=randomUUID(),documentId=randomUUID(),otherDocument=randomUUID(),versionId=randomUUID(),otherVersion=randomUUID()
try {
  const provider=await checkEmbeddingProvider();assert.equal(provider.dimensions,1024)
  await db.insert(projects).values([{id:projectId,code:`HYBRID-${projectId.slice(0,8)}`,name:'混合检索验收'},{id:otherProject,code:`HYBRID-${otherProject.slice(0,8)}`,name:'隔离项目'}])
  await db.insert(knowledgeBases).values([{id:baseId,projectId,name:'混合库'},{id:otherBase,projectId:otherProject,name:'隔离库'}])
  await db.insert(documents).values([{id:documentId,projectId,knowledgeBaseId:baseId,name:'延期风险应对',originalName:'risk.md',fileType:'md',status:'confirmed',parseStatus:'completed',indexStatus:'pending',aiEnabled:false},{id:otherDocument,projectId:otherProject,knowledgeBaseId:otherBase,name:'秘密资料',originalName:'secret.md',fileType:'md',status:'confirmed',parseStatus:'completed',indexStatus:'pending',aiEnabled:false}])
  await db.insert(documentVersions).values([{id:versionId,documentId,versionNumber:'v1',storageKey:`smoke/${versionId}`,isCurrent:true},{id:otherVersion,documentId:otherDocument,versionNumber:'v1',storageKey:`smoke/${otherVersion}`,isCurrent:true}])
  await db.insert(documentChunks).values([{documentId,versionId,chunkIndex:0,content:'供应商交付延迟时，需要增加人员并调整关键路径以确保按期完成。',pageNumber:8,sectionPath:'风险 / 工期'},{documentId:otherDocument,versionId:otherVersion,chunkIndex:0,content:'供应商交付延迟的其他项目秘密。'}])
  const indexed=await embedProjectDocumentVersion(projectId,documentId,versionId);assert.equal(indexed?.generated,1);assert.equal(indexed?.model,EMBEDDING_MODEL)
  const reused=await embedProjectDocumentVersion(projectId,documentId,versionId);assert.equal(reused?.reused,1);assert.equal(reused?.generated,0)
  const semantic=await searchProjectKnowledgeHybrid(projectId,{q:'怎样避免工期拖后',mode:'semantic',minScore:0,limit:10});assert.equal(semantic.total,1);assert.equal(semantic.items[0]?.documentId,documentId);assert.equal(semantic.items[0]?.pageNumber,8);assert.ok(semantic.items[0]!.semanticScore>0)
  const hybrid=await searchProjectKnowledgeHybrid(projectId,{q:'供应商 延迟',mode:'hybrid',minScore:0,limit:10});assert.equal(hybrid.total,1);assert.ok(hybrid.items[0]!.matchedBy.includes('semantic'));assert.ok(hybrid.items[0]!.matchedBy.includes('keyword'))
  const [a,b]=await embedTexts(['固定输入','固定输入']);assert.deepEqual(a,b)
  console.log(JSON.stringify({ok:true,provider:provider.provider,model:provider.model,dimensions:provider.dimensions,idempotent:true,semanticParaphrase:true,hybrid:true,projectIsolation:true,traceable:true}))
} finally { await db.delete(projects).where(eq(projects.id,projectId)).catch(()=>undefined);await db.delete(projects).where(eq(projects.id,otherProject)).catch(()=>undefined);await pool.end() }

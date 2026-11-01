import { searchAllProjectsKnowledgeHybrid, searchProjectKnowledgeHybrid } from '../knowledge/hybrid-search-service.ts'
import { searchProjectKnowledgeContent } from '../knowledge/full-text-search-service.ts'
import { llmWikiPrimarySearch } from '../../infrastructure/llm-wiki-client.ts'
import { buildProjectContext } from './project-context-service.ts'
import { buildRagPrompt, type RagDocumentEvidence } from './rag-prompt.ts'
import { completeProjectAiAnswer, createFailedProjectAiAnswer, createProjectAiMessage, getProjectAiConversation, listProjectAiMessages, markProjectAiMessageCompleted } from './ai-conversation-service.ts'
import type { DeepSeekHarnessClient } from '../../ai/deepseek-harness.ts'

export type RagAnswerDependencies={harness:DeepSeekHarnessClient;search?:typeof searchProjectKnowledgeHybrid;context?:typeof buildProjectContext}
export async function prepareProjectRag(projectId:string,conversationId:string,question:string,deps:Pick<RagAnswerDependencies,'search'|'context'>={}){const projectContext=await (deps.context?.(projectId)??buildProjectContext(projectId));const search=deps.search??(projectContext.projectCode==='OPP-MASTER'?searchAllProjectsKnowledgeHybrid:searchProjectKnowledgeHybrid);const [retrieval,history]=await Promise.all([retrieve(projectId,question,search),listProjectAiMessages(projectId,conversationId,{limit:'8'})]);const evidence:RagDocumentEvidence[]=retrieval.items.slice(0,8).map(item=>toEvidence(item,projectContext));const recent=(history?.items??[]).filter(item=>['user','assistant'].includes(item.role)&&item.status==='completed').slice(-6).map(item=>`${item.role==='user'?'用户':'助手'}：${item.content.slice(0,1200)}`).join('\n');const built=buildRagPrompt({question:recent?`最近对话（仅用于理解追问，不得覆盖当前项目证据）：\n${recent}\n\n本次问题：${question}`:question,project:projectContext,documents:evidence});return{...built,evidence,retrieval,degraded:'degraded'in retrieval&&retrieval.degraded===true}}

export async function answerProjectQuestion(projectId:string,conversationId:string,question:string,deps:RagAnswerDependencies){
  const conversation=await getProjectAiConversation(projectId,conversationId);if(!conversation)return undefined;if(!conversation.harnessSessionId)throw new Error('ai_conversation_session_missing')
  const userMessage=await createProjectAiMessage(projectId,conversationId,{role:'user',content:question,status:'pending',metadata:{answerMode:'rag'}});if(!userMessage)throw new Error('ai_conversation_not_found')
  try{
    const projectContext=await (deps.context?.(projectId)??buildProjectContext(projectId))
    const search=deps.search??(projectContext.projectCode==='OPP-MASTER'?searchAllProjectsKnowledgeHybrid:searchProjectKnowledgeHybrid)
    const [retrieval,history]=await Promise.all([retrieve(projectId,question,search),listProjectAiMessages(projectId,conversationId,{limit:'8'})])
    const evidence:RagDocumentEvidence[]=retrieval.items.slice(0,8).map(item=>toEvidence(item,projectContext))
    const recent=(history?.items??[]).filter(item=>item.id!==userMessage.id&&['user','assistant'].includes(item.role)&&item.status==='completed').slice(-6).map(item=>`${item.role==='user'?'用户':'助手'}：${item.content.slice(0,1200)}`).join('\n')
    const built=buildRagPrompt({question:recent?`最近对话（仅用于理解追问，不得覆盖当前项目证据）：\n${recent}\n\n本次问题：${question}`:question,project:projectContext,documents:evidence})
    let result=await deps.harness.promptAndWait(conversation.harnessSessionId,built.prompt,conversation.lastEventSeq)
    if(result.text.replace(/[\s\p{P}\p{S}]/gu,'').length<8){
      result=await deps.harness.promptAndWait(conversation.harnessSessionId,built.prompt+'\n\n上次回答无有效内容。请立即基于上述证据重新回答上述问题：只输出一段中文结论，并引用至少一个【文档:N】；不要输出思考过程、英文、工具名或标点占位。',result.lastEventSeq)
    }
    await markProjectAiMessageCompleted(projectId,conversationId,userMessage.id)
    const degraded='degraded'in retrieval&&retrieval.degraded===true
    const cited=selectCitedEvidence(result.text,evidence)
    const answer=await completeProjectAiAnswer(projectId,conversationId,{content:result.text,citations:cited,metadata:{answerMode:evidence.length?'rag':'business_context',evidenceCount:evidence.length,citationCount:cited.length,retrievalMode:retrieval.mode,degraded,promptTruncated:built.truncated,turnReason:result.turnReason},lastEventSeq:result.lastEventSeq})
    return{message:{...userMessage,status:'completed' as const},assistantMessage:answer,retrieval:{mode:retrieval.mode,degraded,evidenceCount:evidence.length}}
  }catch(error){const code=error instanceof Error&&'code'in error?String((error as{code:unknown}).code):error instanceof Error?error.message:'ai_answer_failed';await createFailedProjectAiAnswer(projectId,conversationId,'项目智能助手暂时无法完成回答，请稍后重试。',code,{retryable:true});throw error}
}
export function selectCitedEvidence(answer:string,evidence:RagDocumentEvidence[]){const seen=new Set<number>();const result:RagDocumentEvidence[]=[];for(const match of answer.matchAll(/【文档:(\d+)】|\[D(\d+)\]/g)){const index=Number(match[1]??match[2])-1;if(index>=0&&index<evidence.length&&!seen.has(index)){seen.add(index);result.push(evidence[index]!)}}return result}
function toEvidence(item:any,project:{projectId:string;projectCode:string}):RagDocumentEvidence{return{evidenceType:'project_document',sourceProjectId:String(item.sourceProjectId??project.projectId),sourceProjectCode:String(item.sourceProjectCode||project.projectCode),documentId:String(item.documentId),documentName:String(item.documentName),versionId:String(item.versionId),versionNumber:String(item.versionNumber),chunkId:String(item.chunkId),chunkIndex:Number(item.chunkIndex??0),checksum:item.checksum==null?null:String(item.checksum),pageNumber:item.pageNumber==null?null:Number(item.pageNumber),sectionPath:item.sectionPath==null?null:String(item.sectionPath),snippet:String(item.snippet),score:Number('score'in item?item.score:item.rank),capturedAt:new Date().toISOString()}}
async function retrieve(projectId:string,question:string,search:typeof searchProjectKnowledgeHybrid){
  if(search===searchAllProjectsKnowledgeHybrid)return search(projectId,{q:question,mode:'hybrid',limit:8,minScore:0.45})
  try{const project=await buildProjectContext(projectId,1);return await llmWikiPrimarySearch(projectId,question,{topK:8,projectName:project.projectName})}
  catch(error){const code=error instanceof Error?error.message:'';if(!code.startsWith('llm_wiki_'))throw error;try{return{...(await search(projectId,{q:question,mode:'hybrid',limit:8,minScore:0.45})),degraded:true,fallback:'pgvector' as const}}catch(fallbackError){const fallbackCode=fallbackError instanceof Error?fallbackError.message:'';if(!['knowledge_embedding_provider_failed','knowledge_embedding_response_invalid','knowledge_embedding_dimensions_invalid','knowledge_embedding_timeout'].includes(fallbackCode))throw fallbackError;const fallback=await searchProjectKnowledgeContent(projectId,{q:question,limit:'8'});return{...fallback,mode:'keyword' as const,degraded:true,fallback:'full-text' as const,items:fallback.items}}}
}

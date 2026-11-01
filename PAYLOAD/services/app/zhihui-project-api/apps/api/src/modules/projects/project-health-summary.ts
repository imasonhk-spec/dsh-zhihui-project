import { createHash } from 'node:crypto'
import { sql, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { projects } from '../../db/schema.ts'
import { getProjectChangeAnalysis, type ProjectChangeInsight } from './project-change-analysis.ts'
import type { DeepSeekHarnessClient } from '../../ai/deepseek-harness.ts'

type SummaryCache={fingerprint:string;summary:string;source:'model'|'rules';generatedAt:string}
const running=new Map<string,Promise<void>>()
export type ProjectHealthSummary={summary:string;source:'model'|'rules';generatedAt:string}

export async function getProjectHealthSummary(projectId:string,harness?:DeepSeekHarnessClient):Promise<ProjectHealthSummary|undefined>{
 const [project]=await db.select().from(projects).where(eq(projects.id,projectId)).limit(1);if(!project)return undefined
 const analysis=await getProjectChangeAnalysis(projectId,harness);if(!analysis)return undefined
 const fingerprint=JSON.stringify({version:2,model:harness?.selection,source:analysis.source,items:analysis.items.map(item=>[item.title,item.detail,item.level,item.category])})
 const key=createHash('sha256').update(fingerprint).digest('hex')
 const cached=readCache(project.metadata,key)
 if(cached?.source==='model')return cached
 const fallback=cached??{summary:compactRules(project.name,analysis.items),source:'rules' as const,generatedAt:new Date().toISOString()}
 if(!cached)await save(projectId,key,fallback)
 if(harness)startModel(projectId,key,project.name,analysis.items,fallback,harness)
 return fallback
}
function compactRules(name:string,items:ProjectChangeInsight[]){const primary=items.find(item=>item.category==='整体进展')??items[0];const concerns=items.filter(item=>item.level==='critical'||item.level==='warning').slice(0,2);return `${name}：${primary?.detail??'暂无可用变化提示'}${concerns.length?` 重点关注：${concerns.map(item=>item.title).join('、')}。`:''}`.slice(0,160)}
function readCache(metadata:Record<string,unknown>,fingerprint:string){const value=metadata.projectHealthSummary;if(!value||typeof value!=='object'||(value as SummaryCache).fingerprint!==fingerprint)return undefined;const item=value as SummaryCache;return{summary:item.summary,source:item.source,generatedAt:item.generatedAt}}
async function save(projectId:string,fingerprint:string,value:{summary:string;source:'model'|'rules';generatedAt:string}){await db.update(projects).set({metadata:sql`coalesce(${projects.metadata},'{}'::jsonb)||jsonb_build_object('projectHealthSummary',${JSON.stringify({fingerprint,...value})}::jsonb)`}).where(eq(projects.id,projectId))}
function startModel(projectId:string,fingerprint:string,name:string,items:ProjectChangeInsight[],fallback:ProjectHealthSummary,harness:DeepSeekHarnessClient){if(running.has(projectId+fingerprint))return;const task=(async()=>{let session:string|undefined;try{const created=await harness.createSession();session=created.sessionId;const prompt=`你是项目总览高级项目经理。请把项目详细任务模块的AI变化提示二次归纳为一段不超过120字的中文项目整体情况总结。必须只基于提供内容，优先说明整体进展，再说明最重要的风险或阻塞和下一步关注点；不要逐条罗列，不要编造。只输出纯文本，不要标题、Markdown或引号。\n项目：${name}\nAI变化提示：${items.map(item=>`[${item.level}]${item.title}：${item.detail}`).join('\n')}`;const controller=new AbortController();const result=await withTimeout(harness.promptAndWait(created.sessionId,prompt,0,controller.signal),90000,()=>controller.abort());const summary=result.text.trim().replace(/^['"“”]|['"“”]$/g,'').slice(0,120);if(summary)await save(projectId,fingerprint,{summary,source:'model',generatedAt:new Date().toISOString()})}catch{if(session)await harness.cancel(session).catch(()=>undefined)}finally{if(session)await harness.archive(session);running.delete(projectId+fingerprint)}})();running.set(projectId+fingerprint,task)}
async function withTimeout<T>(promise:Promise<T>,ms:number,onTimeout:()=>void){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>{onTimeout();reject(new Error('summary_timeout'))},ms)})])}finally{if(timer)clearTimeout(timer)}}

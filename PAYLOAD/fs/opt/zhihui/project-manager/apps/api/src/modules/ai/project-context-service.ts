import { and, asc, eq } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { approvalItems, coordinationItems, milestones, projectPhases, projects, risks, tasks } from '../../db/schema.ts'

export type ProjectContextFact = { sourceType:'project'|'phase'|'task'|'milestone'|'risk'|'coordination'|'approval';sourceId:string;label:string;text:string;factType:'observed'|'plan'|'forecast'|'assumption' }
export type ProjectContext = { projectId:string;projectCode:string;projectName:string;facts:ProjectContextFact[];text:string;truncated:boolean }

export async function buildProjectContext(projectId:string,maxChars=12_000):Promise<ProjectContext>{
  const [project]=await db.select().from(projects).where(eq(projects.id,projectId)).limit(1);if(!project)throw new Error('project_not_found')
  const [phases,taskRows,milestoneRows,riskRows,coordinationRows,approvalRows]=await Promise.all([
    db.select().from(projectPhases).where(and(eq(projectPhases.projectId,projectId),eq(projectPhases.isCurrent,true))).orderBy(asc(projectPhases.sortOrder)),
    db.select().from(tasks).where(and(eq(tasks.projectId,projectId),eq(tasks.isCurrent,true))).orderBy(asc(tasks.wbsCode)),
    db.select().from(milestones).where(eq(milestones.projectId,projectId)).orderBy(asc(milestones.plannedDate)),
    db.select().from(risks).where(eq(risks.projectId,projectId)),
    db.select().from(coordinationItems).where(eq(coordinationItems.projectId,projectId)),
    db.select().from(approvalItems).where(eq(approvalItems.projectId,projectId)).orderBy(asc(approvalItems.sortOrder)),
  ])
  const facts:ProjectContextFact[]=[
    fact('project',project.id,'项目',`编号=${project.code}；名称=${project.name}；状态=${project.status}；进度=${project.progress}%；健康度=${project.health}；客户=${project.clientName??'未设置'}；说明=${project.description??'无'}`,'observed'),
    fact('project',project.id,'项目基线',`计划=${project.startDate??'未设置'}至${project.plannedEndDate??'未设置'}`,'plan'),
    ...phases.flatMap(item=>[fact('phase',item.id,`阶段 ${item.code}`,`${item.name}；状态=${item.status}；进度=${item.progress}%`,'observed'),fact('phase',item.id,`阶段 ${item.code} 基线`,`计划=${item.plannedStartDate??'未设置'}至${item.plannedEndDate??'未设置'}`,'plan')]),
    ...taskRows.flatMap(item=>[fact('task',item.id,`任务 ${item.wbsCode}`,`${item.name}；状态=${item.status}；优先级=${item.priority}；进度=${item.progress}%；交付物=${item.deliverable??'无'}`,'observed'),fact('task',item.id,`任务 ${item.wbsCode} 计划`,`负责人=${item.ownerName??'未设置'}；计划完成=${item.plannedEndDate??'未设置'}`,'plan')]),
    ...milestoneRows.flatMap(item=>[fact('milestone',item.id,'里程碑',`${item.name}；类型=${item.type}；状态=${item.status}；实际日期=${item.actualDate??'无'}`,'observed'),fact('milestone',item.id,'里程碑计划',`计划日期=${item.plannedDate}；负责人=${item.ownerName??'未设置'}`,'plan')]),
    ...riskRows.filter(item=>!['closed','accepted'].includes(item.status)).flatMap(item=>[fact('risk',item.id,`风险 ${item.code}`,`${item.name}；等级=${item.level}；状态=${item.status}；影响=${item.impact??'无'}`,'observed'),fact('risk',item.id,`风险 ${item.code} 应对`,`负责人=${item.ownerName??'未设置'}；预计解决=${item.expectedResolutionDate??'未设置'}；应对=${item.mitigation??'无'}`,'plan')]),
    ...coordinationRows.filter(item=>!['resolved','closed'].includes(item.status)).flatMap(item=>[fact('coordination',item.id,`协调 ${item.code}`,`${item.title}；分类=${item.category}；优先级=${item.priority}；状态=${item.status}；进度=${item.progress}%`,'observed'),fact('coordination',item.id,`协调 ${item.code} 计划`,`截止=${item.dueDate??'未设置'}；负责人=${item.ownerName??'未设置'}`,'plan')]),
    ...approvalRows.flatMap(item=>[fact('approval',item.id,`报批 ${item.stageCode}`,`${item.stageName}/${item.taskName}；状态=${item.status}；结果=${item.result??'无'}`,'observed'),fact('approval',item.id,`报批 ${item.stageCode} 计划`,`计划=${item.plannedStartDate??'未设置'}至${item.plannedEndDate??'未设置'}；责任方=${item.responsibleParty??'未设置'}`,'plan')]),
  ]
  const lines:string[]=[];let size=0;let truncated=false
  for(const item of facts){const line=`[业务数据库:${item.sourceType}:${item.sourceId}] ${item.label}｜${item.text}`;if(size+line.length+1>maxChars){truncated=true;break}lines.push(line);size+=line.length+1}
  return {projectId,projectCode:project.code,projectName:project.name,facts,text:lines.join('\n'),truncated}
}
function fact(sourceType:ProjectContextFact['sourceType'],sourceId:string,label:string,text:string,factType:ProjectContextFact['factType']):ProjectContextFact{return{sourceType,sourceId,label,text,factType}}

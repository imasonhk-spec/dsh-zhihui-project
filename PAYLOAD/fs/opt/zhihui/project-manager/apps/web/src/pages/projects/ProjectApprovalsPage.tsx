import { Button, Card, Drawer, Form, Input, Modal, Select, Space, Tag, Typography } from '@arco-design/web-react'
import { IconCalendar, IconCheck, IconCheckCircle, IconClockCircle, IconDownload, IconFile, IconPlus, IconRefresh, IconRight, IconThunderbolt } from '@arco-design/web-react/icon'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { createApproval, listApprovals, updateApproval, type ApprovalInput, type ApprovalItem, type ApprovalSummary } from '../../api/projects.ts'
import { EmptyState, ErrorState, LoadingState } from '../../components/feedback/index.ts'
import { useProjectContext } from '../../contexts/ProjectContext.tsx'
import { ApiError } from '../../lib/api-client.ts'
import { downloadCsv } from '../../lib/csv.ts'

const stages=[['all','全部阶段'],['s1','项目建议书'],['s2','项目初设编制与审批'],['s3','项目招投标'],['s4','项目合同签订']] as const
const statuses=[['all','全部状态'],['not_started','未开始'],['in_progress','进行中'],['completed','已完成'],['closed','已关闭'],['cancelled','已取消']] as const
const stageNumbers=['一','二','三','四','五','六','七','八']

export function ProjectApprovalsPage(){
  const{projectId=''}=useParams<{projectId:string}>();const{projects}=useProjectContext();const[params,setParams]=useSearchParams()
  const[data,setData]=useState<{items:ApprovalItem[];summary:ApprovalSummary}>();const[timelineData,setTimelineData]=useState<{items:ApprovalItem[];summary:ApprovalSummary}>();const[loading,setLoading]=useState(true),[error,setError]=useState<string>(),[selected,setSelected]=useState<ApprovalItem|null>(null),[mode,setMode]=useState<'new'|'edit'|null>(null)
  const stage=params.get('stageCode')??'all',status=params.get('status')??'all',include=params.get('includeCompleted')!=='false',q=params.get('q')??''
  const project=projects.find(item=>item.id===projectId)
  const loadTimeline=useCallback(async()=>setTimelineData(await listApprovals(projectId,{includeCompleted:'true'})),[projectId])
  const load=useCallback(async()=>{setLoading(true);setError(undefined);try{setData(await listApprovals(projectId,{...(stage!=='all'?{stageCode:stage}:{}),...(status!=='all'?{status}:{}),...(include?{includeCompleted:'true'}:{})}))}catch(e){setError(e instanceof ApiError?e.message:'报批数据加载失败')}finally{setLoading(false)}},[include,projectId,stage,status])
  useEffect(()=>{void Promise.all([load(),loadTimeline()]).catch(e=>setError(e instanceof ApiError?e.message:'报批数据加载失败'))},[load,loadTimeline])
  if(loading&&!data)return <LoadingState title="正在加载立项报批进度" description="正在读取计划实施表中的立项报批推进计划。"/>
  if(error||!data)return <ErrorState description={error??'报批数据加载失败'} onRetry={load}/>
  const items=data.items.filter(item=>!q||[item.taskName,item.stageName,item.deliverable??'',item.responsibleParty??''].some(v=>v.toLowerCase().includes(q.toLowerCase())))
  const summary=data.summary
  const setFilter=(key:string,value:string)=>{const n=new URLSearchParams(params);if(!value||value==='all')n.delete(key);else n.set(key,value);setParams(n)}
  const reset=()=>setParams(new URLSearchParams())
  const exportHeaders=['序号','阶段','任务','输出物/验收标准','责任单位','计划开始','计划完成','状态'];const exportRows=items.map((x,index)=>[index+1,x.stageName,x.taskName,x.deliverable??'',x.responsibleParty??'',x.plannedStartDate??'',x.plannedEndDate??'',statusLabel(x.status)])
  const dateRange=approvalDateRange(data.items)
  return <div className="approval-page approval-prototype">
    <header className="approval-prototype__head"><div><Typography.Title heading={3}>项目立项报批</Typography.Title><Typography.Paragraph type="secondary">专项监控立项审批进度 · {project?.name??'当前项目'} · 数据截至 {formatDate(new Date().toISOString())}</Typography.Paragraph></div><Space><Button icon={<IconDownload/>} onClick={()=>downloadCsv('项目立项报批台账.csv',exportHeaders,exportRows)}>导出报批台账</Button><Button type="primary" icon={<IconPlus/>} onClick={()=>setMode('new')}>新增报批任务</Button></Space></header>

    <Card className="approval-prototype__filter"><div className="approval-prototype__filter-row"><label><span>项目</span><Select value={projectId} options={project?[{value:projectId,label:project.name}]:[]} disabled/></label><label><span>报批阶段</span><Select value={stage} options={stages.map(([value,label])=>({value,label}))} onChange={value=>setFilter('stageCode',value)}/></label><label><span>任务状态</span><Select value={status} options={statuses.map(([value,label])=>({value,label}))} onChange={value=>setFilter('status',value)}/></label><label className="approval-prototype__date"><span>时间范围</span><div><IconCalendar/>{dateRange}</div></label><span className="approval-prototype__filter-actions"><Button type="primary">查询</Button><Button onClick={reset}>重置</Button></span></div></Card>

    <ApprovalTimeline items={timelineData?.items??data.items} summary={timelineData?.summary??summary} projectName={project?.name??'当前项目'}/>

    <div className="approval-prototype__lower">
      <Card className="approval-prototype__table-card" title={<div><b><IconCheckCircle/>关键节点明细</b><small>共 {items.length} 项报批任务 · <em>红色</em>为逾期，橙色为临期</small></div>} extra={<Tag>数据来源：立项报批推进计划</Tag>}>
        <ApprovalTable items={items} onDetail={setSelected}/>
      </Card>
      <RecentChanges items={data.items}/>
    </div>
    <ApprovalDetail item={selected} onClose={()=>setSelected(null)} onEdit={()=>setMode('edit')}/>
    <ApprovalForm projectId={projectId} mode={mode} item={selected} onClose={()=>setMode(null)} onSaved={()=>{setMode(null);void Promise.all([load(),loadTimeline()])}}/>
  </div>
}

type ApprovalFlowNode={key:string;name:React.ReactNode;plainName:string;items:ApprovalItem[];missing:boolean;done:boolean;current:boolean;date:string|null}
const approvalFlow=[
  {key:'proposal',plainName:'项目建议书',name:'项目建议书',match:(item:ApprovalItem)=>/项目建议书内容|正式提交/.test(item.taskName)},
  {key:'precheck',plainName:'立项预审',name:<>立项预审<br/>（政数局）</>,match:(item:ApprovalItem)=>/项目建议书审批|立项预审/.test(item.taskName)},
  {key:'feasibility',plainName:'可研预审',name:'可研预审',match:(item:ApprovalItem)=>/可研/.test(item.taskName)},
  {key:'design',plainName:'初设预审',name:'初设预审',match:(item:ApprovalItem)=>item.stageCode==='s2'&&!/党组|分管区领导|发改/.test(item.taskName)},
  {key:'party',plainName:'党组会/分管区领导审议',name:<>党组会/分管区<br/>领导审议</>,match:(item:ApprovalItem)=>/党组|分管区领导/.test(item.taskName)},
  {key:'reform',plainName:'发改批复',name:'发改批复',match:(item:ApprovalItem)=>/发改/.test(item.taskName)},
  {key:'tender',plainName:'招投标',name:'招投标',match:(item:ApprovalItem)=>item.stageCode==='s3'},
  {key:'contract',plainName:'合同签订',name:'合同签订',match:(item:ApprovalItem)=>item.stageCode==='s4'},
]
function buildApprovalFlow(items:ApprovalItem[]){const nodes=approvalFlow.map(def=>{const matched=items.filter(def.match);return{...def,items:matched,missing:matched.length===0,done:matched.length>0&&matched.every(item=>['completed','closed'].includes(item.status)),current:false,date:matched.map(item=>item.plannedEndDate).filter((value):value is string=>Boolean(value)).sort().at(-1)??null}});const current=nodes.find(node=>!node.missing&&!node.done);if(current)current.current=true;return nodes}
function ApprovalTimeline({items,summary,projectName}:{items:ApprovalItem[];summary:ApprovalSummary;projectName:string}){
  const nodes=buildApprovalFlow(items),completed=nodes.filter(node=>node.done).length,current=nodes.find(node=>node.current),missing=nodes.filter(node=>node.missing)
  return <Card className="approval-prototype__timeline" title={<div><b><IconFile/>报批进度时间轴</b><small>{projectName}</small></div>} extra={<Tag color={current?'orange':'green'}>{current?`进行中 · ${current.plainName}`:'已完成'}</Tag>}>
    <div className="approval-prototype__flow-note"><b>报批流程</b>：项目建议书 → 立项预审（政数局） → 可研预审 → 初设预审 → 党组会/分管区领导审议 → 发改批复 → 招投标 → 合同签订<br/>{missing.length>0&&<><b className="is-warning">环节缺失提示</b>：{missing.map(node=>node.plainName).join('、')}在当前报批计划中未安排独立任务</>}</div>
    <div className="approval-prototype__summary-strip"><SummaryItem label="当前节点"><Tag color="arcoblue">{current?.plainName??'已完成'}</Tag></SummaryItem><SummaryItem label="流程进度"><strong>{completed}</strong> / 8 节点已完成</SummaryItem><SummaryItem label="最近截止">{summary.nextDeadline?<>{summary.nextDeadline.taskName}<i className={summary.nextDeadline.warning.level}>{summary.nextDeadline.warning.label}</i></>:'暂无待办节点'}</SummaryItem><SummaryItem label="预计合同签订">{summary.expectedContractDate??'未设置'}</SummaryItem></div>
    <div className="approval-prototype__nodes">{nodes.map((node,index)=><TimelineNode key={node.key} node={node} index={index}/>)}</div>
  </Card>
}
function SummaryItem({label,children}:{label:string;children:React.ReactNode}){return <div><span>{label}</span><p>{children}</p></div>}
function TimelineNode({node,index}:{node:ApprovalFlowNode;index:number}){return <div className={`approval-prototype__node${node.done?' is-done':''}${node.current?' is-current':''}${node.missing?' is-missing':''}`}><span>{node.done?<IconCheck/>:node.current?<IconRight/>:index+1}</span><b>{node.name}</b><small>{node.missing?'无独立报批任务':node.date?`${node.done?'完成':'计划'} ${shortDate(node.date)}`:'未设置日期'}</small><Tag color={node.done?'green':node.current?'arcoblue':node.missing?'orange':'gray'}>{node.done?'已完成':node.current?'进行中':node.missing?'环节缺失':'未开始'}</Tag></div>}

function ApprovalTable({items,onDetail}:{items:ApprovalItem[];onDetail:(item:ApprovalItem)=>void}){const groups=[...items.reduce((map,item)=>{const key=`${item.stageCode}|${item.stageName}`;const rows=map.get(key)??[];rows.push(item);map.set(key,rows);return map},new Map<string,ApprovalItem[]>()).entries()];if(!groups.length)return <EmptyState title="没有符合条件的报批任务" description="请调整筛选条件或导入立项报批推进计划。"/>;let sequence=0;return <div className="approval-prototype__table-wrap"><table><thead><tr><th>序号</th><th>任务</th><th>输出物/验收标准</th><th>责任单位</th><th>计划开始</th><th>计划完成</th><th>状态</th></tr></thead><tbody>{groups.flatMap(([key,rows],groupIndex)=>[<tr className="approval-prototype__group" key={`${key}:group`}><td colSpan={7}>{stageNumbers[groupIndex]??groupIndex+1}、{rows[0]!.stageName}<small>{rows.length} 项任务</small></td></tr>,...rows.map(item=>{sequence++;return <tr key={item.id} className={item.warning.level==='overdue'?'is-overdue':item.warning.level==='upcoming'?'is-upcoming':''}><td>{sequence}</td><td><button onClick={()=>onDetail(item)}>{item.taskName}</button></td><td className="approval-prototype__deliverable">{item.deliverable||'—'}</td><td>{item.responsibleParty||'—'}</td><td>{item.plannedStartDate||'—'}</td><td>{item.plannedEndDate||'—'}{item.warning.level!=='normal'&&<i className={item.warning.level}>{item.warning.label}</i>}</td><td><ApprovalStatus status={item.status}/></td></tr>})])}</tbody></table></div>}
function ApprovalStatus({status}:{status:ApprovalItem['status']}){return <Tag color={status==='completed'||status==='closed'?'green':status==='in_progress'?'arcoblue':status==='cancelled'?'red':'gray'}>{statusLabel(status)}</Tag>}
function RecentChanges({items}:{items:ApprovalItem[]}){const recent=useMemo(()=>[...items].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).slice(0,4),[items]);return <Card className="approval-prototype__changes" title={<div><b><IconThunderbolt/>较上周变化</b><small>近期完成 / 新启动</small></div>}>{recent.length?recent.map(item=><article key={item.id}><span className={item.status==='completed'||item.status==='closed'?'done':item.status==='in_progress'?'doing':'new'}>{item.status==='completed'||item.status==='closed'?<IconCheckCircle/>:item.status==='in_progress'?<IconRefresh/>:<IconPlus/>}</span><div><p><b>{item.taskName}</b>：{item.result||item.deliverable||statusLabel(item.status)}</p><small>{formatDate(item.updatedAt)} · {statusLabel(item.status)}</small></div></article>):<EmptyState title="暂无近期变化" description="报批任务更新后将在此展示。"/>}</Card>}

function ApprovalDetail({item,onClose,onEdit}:{item:ApprovalItem|null;onClose:()=>void;onEdit:()=>void}){return <Drawer width={520} title="报批任务详情" visible={Boolean(item)} onCancel={onClose} footer={item?<Button type="primary" onClick={onEdit}>编辑任务</Button>:null}>{item&&<div className="approval-detail"><Typography.Title heading={5}>{item.taskName}</Typography.Title>{[['阶段',item.stageName],['输出物',item.deliverable||'—'],['责任单位',item.responsibleParty||'—'],['计划时间',`${item.plannedStartDate||'—'} 至 ${item.plannedEndDate||'—'}`],['实际时间',`${item.actualStartDate||'—'} 至 ${item.actualEndDate||'—'}`],['状态',statusLabel(item.status)],['预警',item.warning.label],['办理结果',item.result||'—'],['备注',item.remark||'—']].map(([a,b])=><div className="approval-detail__row" key={a}><Typography.Text type="secondary">{a}</Typography.Text><Typography.Text>{b}</Typography.Text></div>)}</div>}</Drawer>}
function ApprovalForm({projectId,mode,item,onClose,onSaved}:{projectId:string;mode:'new'|'edit'|null;item:ApprovalItem|null;onClose:()=>void;onSaved:()=>void}){const[form]=Form.useForm();const[saving,setSaving]=useState(false);useEffect(()=>{form.resetFields();if(item&&mode==='edit')form.setFieldsValue(item);else form.setFieldsValue({stageCode:'s1',stageName:'项目建议书',status:'not_started',sortOrder:1})},[form,item,mode]);if(!mode)return null;const submit=async()=>{try{const v=await form.validate();setSaving(true);if(mode==='new')await createApproval(projectId,v as ApprovalInput);else if(item)await updateApproval(projectId,item.id,v as Partial<ApprovalInput>);onSaved()}catch(e){if(!(e instanceof Error&&e.message.includes('required')))alert(e instanceof ApiError?e.message:'保存报批任务失败')}finally{setSaving(false)}};return <Modal title={mode==='new'?'新增报批任务':'编辑报批任务'} visible onCancel={onClose} onOk={submit} confirmLoading={saving}><Form form={form} layout="vertical"><Form.Item field="stageCode" label="阶段编码"><Select options={stages.filter(x=>x[0]!=='all').map(([value,label])=>({value,label}))}/></Form.Item><Form.Item field="stageName" label="阶段名称" rules={[{required:true}]}><Input/></Form.Item><Form.Item field="taskName" label="任务名称" rules={[{required:true}]}><Input/></Form.Item><Form.Item field="deliverable" label="输出物/验收标准"><Input.TextArea/></Form.Item><Form.Item field="responsibleParty" label="责任单位"><Input/></Form.Item><Form.Item field="status" label="状态"><Select options={statuses.filter(x=>x[0]!=='all').map(([value,label])=>({value,label}))}/></Form.Item><Form.Item field="plannedStartDate" label="计划开始"><Input placeholder="YYYY-MM-DD"/></Form.Item><Form.Item field="plannedEndDate" label="计划完成"><Input placeholder="YYYY-MM-DD"/></Form.Item><Form.Item field="result" label="办理结果"><Input.TextArea/></Form.Item><Form.Item field="remark" label="备注"><Input.TextArea/></Form.Item></Form></Modal>}

function statusLabel(status:ApprovalItem['status']){return({not_started:'未开始',in_progress:'进行中',completed:'已完成',closed:'已关闭',cancelled:'已取消'} as const)[status]}
function approvalDateRange(items:ApprovalItem[]){const dates=items.flatMap(item=>[item.plannedStartDate,item.plannedEndDate]).filter((value):value is string=>Boolean(value)).sort();return dates.length?`${dates[0]} ~ ${dates.at(-1)}`:'未设置计划时间'}
function shortDate(value:string){return value.slice(5)}
function formatDate(value:string){return new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))}

import { Button, Card, Drawer, Form, Input, Message, Modal, Select, Space, Table, Tag, Typography, Checkbox, Tooltip } from '@arco-design/web-react'
import { IconPlus, IconRefresh } from '@arco-design/web-react/icon'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  createImportJob,
  executeDeliveryMeetingTodoImport,
  executeProjectImport,
  executeWeeklyBatchImport,
  previewWeeklyBatchImport,
  previewDeliveryMeetingTodoImport,
  listImportJobs,
  previewProjectImport,
  previewImplementationPlanChanges,
  confirmImplementationPlanChanges,
  type ImplementationPlanChangePreview,
  type ImportChangeItem,
  type ImportFieldChange,
  type ImportJob,
  type ImportJobInput,
  type ImportKind,
  type ImportPreview,
  type ImportUploadInput,
  type DeliveryMeetingTodoPreview,
} from '../../api/projects.ts'
import { EmptyState, ErrorState, LoadingState } from '../../components/feedback/index.ts'
import { StatusTag } from '../../components/ui/StatusTag.tsx'
import { ApiError } from '../../lib/api-client.ts'

const kindLabels: Record<string, string> = {
  tasks: '任务', task: '任务', risks: '风险', risk: '风险', milestones: '里程碑', milestone: '里程碑',
  phases: '阶段', phase: '阶段', coordination: '协调事项', approvals: '立项报批', approval: '立项报批',
}
const importKinds: Array<{ label: string; value: ImportKind }> = [
  { label: '任务', value: 'tasks' }, { label: '风险', value: 'risks' },
  { label: '里程碑', value: 'milestones' }, { label: '阶段', value: 'phases' },
]
const statusLabels: Record<string, string> = { pending: '待处理', processing: '处理中', completed: '已完成', failed: '失败' }
function currentWeekRange() { const now = new Date(); const day = now.getDay() || 7; const start = new Date(now); start.setDate(now.getDate() - day + 1); const end = new Date(start); end.setDate(start.getDate() + 4); const iso = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; return [iso(start), iso(end)] as const }
const defaultBatchWeek = currentWeekRange()
const importHeaderLabels: Record<string, string> = { wbsCode:'WBS编号',name:'任务/风险/里程碑名称',phaseName:'一级模块',vendor:'承建方',ownerName:'责任人/责任方',plannedStartDate:'开始时间',plannedEndDate:'计划完成时间',plannedDate:'计划完成时间',progress:'完成进度',status:'当前状态',deliverable:'交付物/范围说明',description:'补充说明',level:'风险等级',source:'风险来源',mitigation:'应对措施',impact:'影响及概率',code:'业务编码',type:'里程碑类型' }

export function ProjectImportsPage() {
  const { projectId = '' } = useParams<{ projectId: string }>()
  const [jobs, setJobs] = useState<ImportJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [modalVisible, setModalVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<ImportJobInput>()
  const [importKind, setImportKind] = useState<ImportKind>('tasks')
  const [file, setFile] = useState<File>()
  const [preview, setPreview] = useState<ImportPreview>()
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string>()
  const [executeLoading, setExecuteLoading] = useState(false)
  const [executeResult, setExecuteResult] = useState<ImportJob>()
  const [changePreview, setChangePreview] = useState<ImplementationPlanChangePreview>()
  const [changeDetail, setChangeDetail] = useState<ImportChangeItem>()
  const [changeTypeFilter, setChangeTypeFilter] = useState('changed')
  const [confirmCritical, setConfirmCritical] = useState(false)
  const [deliveryTodoFile, setDeliveryTodoFile] = useState<File>(); const [deliveryTodoPreview, setDeliveryTodoPreview] = useState<DeliveryMeetingTodoPreview>(); const [deliveryTodoLoading, setDeliveryTodoLoading] = useState(false); const [deliveryTodoMessage, setDeliveryTodoMessage] = useState<string>();
  const [batchStart, setBatchStart] = useState(defaultBatchWeek[0]); const [batchEnd, setBatchEnd] = useState(defaultBatchWeek[1]); const [autoCreate, setAutoCreate] = useState(true); const [batchFiles, setBatchFiles] = useState<File[]>([]); const [batchLoading, setBatchLoading] = useState(false); const [batchElapsed, setBatchElapsed] = useState(0); const [batchError, setBatchError] = useState<string>(); const [batchNotice, setBatchNotice] = useState<string>(); const [batchResult, setBatchResult] = useState<Awaited<ReturnType<typeof executeWeeklyBatchImport>>>(); const [batchPreview, setBatchPreview] = useState<Awaited<ReturnType<typeof previewWeeklyBatchImport>>>(); const [batchPreviewLoading, setBatchPreviewLoading] = useState(false); const [bindings, setBindings] = useState<Record<string,string>>({}); const [confirmNameChanges, setConfirmNameChanges] = useState(false)

  const load = useCallback(async () => {
    if (!projectId) { setJobs([]); setLoading(false); return }
    setLoading(true); setError(undefined)
    try { setJobs(await listImportJobs(projectId)) }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : '导入任务加载失败') }
    finally { setLoading(false) }
  }, [projectId])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (!batchLoading) return; setBatchElapsed(0); const timer = window.setInterval(() => setBatchElapsed(value => value + 1), 1000); return () => window.clearInterval(timer) }, [batchLoading])

  const openCreate = () => { if (!projectId) return; form.resetFields(); setModalVisible(true) }
  const submit = async () => {
    if (!projectId) return
    try {
      const values = await form.validate() as ImportJobInput
      setSaving(true); await createImportJob(projectId, values); Message.success('导入任务已登记'); setModalVisible(false); await load()
    } catch (reason) {
      if (!(reason instanceof Error && reason.message.includes('required'))) Message.error(reason instanceof ApiError ? reason.message : '导入任务登记失败')
    } finally { setSaving(false) }
  }
  const selectFile = (next?: File) => { setFile(next); setPreview(undefined); setChangePreview(undefined); setChangeDetail(undefined); setConfirmCritical(false); setPreviewError(undefined); setExecuteResult(undefined) }
  const previewImport = async () => {
    if (!file) { Message.warning('请先选择 CSV、XLSX 或 XLSM 文件'); return }
    const input: ImportUploadInput = { kind: importKind, file }
    setPreviewLoading(true); setPreviewError(undefined); setPreview(undefined); setChangePreview(undefined); setExecuteResult(undefined)
    try {
      if(importKind==='tasks') setChangePreview(await previewImplementationPlanChanges(projectId,file))
      else setPreview(await previewProjectImport(projectId, input))
    }
    catch (reason) { setPreviewError(reason instanceof ApiError ? reason.message : '文件预览失败') }
    finally { setPreviewLoading(false) }
  }
  const executeImport = async () => {
    if (!file) return
    setExecuteLoading(true)
    try {
      if(importKind==='tasks'&&changePreview){
        const critical=changePreview.summary.bySeverity.critical>0
        if(critical&&!confirmCritical){Message.warning('请先勾选确认关键变化');return}
        const result=await confirmImplementationPlanChanges(projectId,changePreview,critical&&confirmCritical)
        Message.success(result.idempotent?'该批次已导入，无需重复执行':'变化批次导入完成');setChangePreview({...changePreview,batch:{...changePreview.batch,status:'succeeded',appliedAt:result.batch.appliedAt},summary:result.summary});await load();return
      }
      if(!preview||preview.errors.length)return
      const result = await executeProjectImport(projectId, { kind: importKind, file })
      setExecuteResult(result); Message.success('导入执行完成'); await load()
    } catch (reason) { Message.error(reason instanceof ApiError ? reason.message : '导入执行失败') }
    finally { setExecuteLoading(false) }
  }
  const previewBatch = async () => { if (!batchFiles.length) { setBatchError('请先选择计划表文件'); return }; setBatchPreviewLoading(true); setBatchError(undefined); setBatchNotice(undefined); try { const result = await previewWeeklyBatchImport(batchFiles); setBatchPreview(result); setBindings(Object.fromEntries(result.filter(item => item.matchedProject).map(item => [item.fileName, item.matchedProject!.id]))); const createCount = result.filter(item => !item.matchedProject).length; setBatchNotice(createCount ? `识别完成：${result.length - createCount} 份更新已有项目，${createCount} 份将自动新建项目。` : `识别完成：${result.length} 份均匹配已有项目。`) } catch (reason) { setBatchError(reason instanceof ApiError ? reason.message : '批量预览失败') } finally { setBatchPreviewLoading(false) } }
  const runBatch = async () => { setBatchError(undefined); setBatchNotice(undefined); if (!batchFiles.length) { setBatchError('请先选择计划表文件'); return }; if (!batchStart || !batchEnd) { setBatchError('请选择周起始和周结束日期'); return }; if (batchStart > batchEnd) { setBatchError('周起始日期不能晚于周结束日期'); return }; if (!batchPreview) { setBatchError('请先点击“识别项目”确认项目匹配关系'); return }; if (!autoCreate && batchPreview.some(item => !item.matchedProject && !bindings[item.fileName])) { setBatchError('自动新建已关闭，请为所有未匹配文件选择已有项目'); return }; setBatchLoading(true); try { const result = await executeWeeklyBatchImport({ weekStart: batchStart, weekEnd: batchEnd, files: batchFiles, bindings, autoCreate, confirmNameChanges }); setBatchResult(result); const changes = result.results.filter(item => item.status === 'name_change_confirmation_required'); if (changes.length && !confirmNameChanges) { setConfirmNameChanges(true); setBatchNotice(`发现 ${changes.length} 个项目名称变更，请确认后再次执行。`) } else { setConfirmNameChanges(false); setBatchNotice(`批量导入完成：成功 ${result.successFiles} 份，失败 ${result.failedFiles} 份。`); await load() } } catch (reason) { setBatchError(reason instanceof ApiError ? reason.message : '批量导入失败') } finally { setBatchLoading(false) } }
  const previewDeliveryTodos = async () => { if (!deliveryTodoFile) return; setDeliveryTodoLoading(true); setDeliveryTodoMessage(undefined); try { setDeliveryTodoPreview(await previewDeliveryMeetingTodoImport(deliveryTodoFile)) } catch (reason) { setDeliveryTodoMessage(reason instanceof ApiError ? reason.message : '周会待办表预览失败') } finally { setDeliveryTodoLoading(false) } }
  const importDeliveryTodos = async () => { if (!deliveryTodoFile || !deliveryTodoPreview) return; setDeliveryTodoLoading(true); setDeliveryTodoMessage(undefined); try { const result = await executeDeliveryMeetingTodoImport(deliveryTodoFile); const archiveIssue = result.archiveErrors?.length ? `；${result.archiveErrors.length} 个项目归档失败，知识库中查不到这些项目的源表` : ''; const indexIssue = result.indexWarnings?.length ? `；${result.indexWarnings.length} 条索引警告（${[...new Set(result.indexWarnings.map(w => w.stage))].join('、')}），AI 检索可能不完整` : ''; setDeliveryTodoMessage(`已新增本次导入：${result.totalRows} 条，匹配项目 ${result.matchedRows} 条，未匹配 ${result.unmatchedRows} 条，并归档至 ${result.archivedProjects ?? 0} 个项目知识库，已完成解析与向量索引${archiveIssue}${indexIssue}。业务数据已切换到本次最新批次。`) } catch (reason) { setDeliveryTodoMessage(reason instanceof ApiError ? reason.message : '周会待办表导入失败') } finally { setDeliveryTodoLoading(false) } }
  const previewColumns = useMemo(() => (preview?.headers ?? []).map(header => ({ title: importHeaderLabels[header] ?? header, dataIndex: header, key: header, render: (value: string) => value || '—' })), [preview?.headers])
  const visibleChangeItems=useMemo(()=>changePreview?.items.filter(item=>changeTypeFilter==='all'||(changeTypeFilter==='changed'?item.changeType!=='unchanged':item.changeType===changeTypeFilter))??[],[changePreview,changeTypeFilter])

  if (loading && !jobs.length) return <LoadingState title="正在加载导入任务" description="正在获取当前项目的导入任务登记记录。" />
  if (error && !jobs.length) return <ErrorState title="导入任务加载失败" description={error} onRetry={load} />
  return <div className="project-detail-page">
    <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
      <div><Typography.Title heading={3}>项目导入任务</Typography.Title><Typography.Paragraph type="secondary">导入始终归属当前项目；同一项目可重复上传多份计划表，任务按 WBS 编号更新，其他新增数据按项目内唯一规则校验，并保留每次文件名和导入结果。</Typography.Paragraph></div>
      <Space><Button icon={<IconRefresh />} loading={loading} onClick={() => void load()}>刷新</Button><Button type="primary" icon={<IconPlus />} onClick={openCreate}>登记导入任务</Button></Space>
    </header>
    <Card title="项目交付中心周会待办事项汇总表" style={{ marginBottom: 16 }}><Space direction="vertical" style={{ width: '100%' }} size={12}><Typography.Paragraph type="secondary">导入中心周会待办，按“所属项目”自动匹配智汇·项目中的项目并写入专用数据库表；原始文件归档至匹配项目知识库“01-项目管理过程/05-项目交付中心周会待办事项汇总表”。</Typography.Paragraph><Space wrap><input type="file" accept=".xlsx" onChange={event=>{setDeliveryTodoFile(event.target.files?.[0]);setDeliveryTodoPreview(undefined);setDeliveryTodoMessage(undefined)}}/><Button loading={deliveryTodoLoading} disabled={!deliveryTodoFile} onClick={()=>void previewDeliveryTodos()}>预览匹配</Button><Button type="primary" loading={deliveryTodoLoading} disabled={!deliveryTodoPreview||deliveryTodoPreview.errors.length>0} onClick={()=>void importDeliveryTodos()}>执行导入</Button></Space>{deliveryTodoMessage?<Typography.Text type={deliveryTodoMessage.includes('失败')?'error':'success'}>{deliveryTodoMessage}</Typography.Text>:null}{deliveryTodoPreview?<Card size="small" title={`预览：共 ${deliveryTodoPreview.totalRows} 条，匹配 ${deliveryTodoPreview.matchedRows} 条，未匹配 ${deliveryTodoPreview.unmatchedRows} 条`}><Table size="small" rowKey="sourceRow" data={deliveryTodoPreview.rows} pagination={{pageSize:5}} scroll={{x:1100}} columns={[{title:'序号',dataIndex:'sequence',width:70},{title:'待办事项',dataIndex:'title',width:320},{title:'责任人',dataIndex:'ownerName',width:100},{title:'截止时间/节点',dataIndex:'deadlineText',width:150},{title:'原所属项目',dataIndex:'projectNameRaw',width:160},{title:'匹配项目',dataIndex:'matchedProjectName',width:220,render:value=>value?<Tag color="green">{value}</Tag>:<Tag color="orange">未匹配</Tag>},{title:'状态',dataIndex:'status',width:100},{title:'备注',dataIndex:'resultRemark',width:240}]}/></Card>:null}</Space></Card>
    <Card title="按周批量导入（跨项目）" style={{ marginBottom: 16 }}><Space wrap><Checkbox checked={autoCreate} onChange={setAutoCreate}>未匹配项目自动新建</Checkbox><Typography.Text>周起始</Typography.Text><input type="date" value={batchStart} onChange={e => setBatchStart(e.target.value)} /><Typography.Text>周结束</Typography.Text><input type="date" value={batchEnd} onChange={e => setBatchEnd(e.target.value)} /><input type="file" accept=".xlsx,.xlsm" multiple onChange={e => { setBatchFiles(Array.from(e.target.files ?? [])); setBatchPreview(undefined); setBatchResult(undefined); setBatchError(undefined); setBatchNotice(undefined) }} /><Button loading={batchPreviewLoading} disabled={!batchFiles.length} onClick={() => void previewBatch()}>识别项目</Button><Button type="primary" loading={batchLoading} disabled={!batchFiles.length || !batchPreview} onClick={() => void runBatch()}>{confirmNameChanges ? '确认名称变更并导入' : '执行批量导入'}</Button></Space><Typography.Paragraph type="secondary">一次选择多个项目计划表：同名或同编码项目自动更新，未匹配项目默认新建；系统导入任务、风险、里程碑和协调事项，并将原表归档至项目知识库，自动完成解析与向量索引。单个文件失败不会影响其他文件。</Typography.Paragraph>{batchFiles.length ? <Typography.Text type="secondary">已选择 {batchFiles.length} 份：{batchFiles.map(f => f.name).join('、')}</Typography.Text> : null}{batchLoading ? <Typography.Paragraph type="warning" style={{ marginTop: 10 }}>正在逐份导入结构化数据、归档知识库并生成向量索引，已耗时 {formatElapsed(batchElapsed)}。10 份文件通常需要 2–5 分钟，请勿重复点击或刷新页面。</Typography.Paragraph> : null}{batchError ? <Typography.Paragraph type="error" style={{ marginTop: 10 }}>{batchError}</Typography.Paragraph> : null}{batchNotice ? <Typography.Paragraph type="success" style={{ marginTop: 10 }}>{batchNotice}</Typography.Paragraph> : null}{batchPreview ? <Table size="small" pagination={false} rowKey="fileName" data={batchPreview} columns={[{title:'文件',dataIndex:'fileName'},{title:'识别项目',dataIndex:'projectKey'},{title:'绑定项目',render:(_,item) => item.matchedProject ? <Tag color="green">更新：{item.matchedProject.name}</Tag> : <Space><Tag color="blue">{autoCreate && !bindings[item.fileName] ? '将自动新建' : '未匹配'}</Tag><Select allowClear placeholder="可选：改绑已有项目" value={bindings[item.fileName]} onChange={value => setBindings(current => { const next={...current}; if(value) next[item.fileName]=value; else delete next[item.fileName]; return next })} options={item.projects.map(project => ({label:`${project.code} · ${project.name}`,value:project.id}))} style={{width:260}}/></Space>}]} /> : null}{batchResult ? <div><Typography.Text type={batchResult.failedFiles || confirmNameChanges ? 'warning' : 'success'}>批次结果：成功 {batchResult.successFiles} 份，待处理/失败 {batchResult.failedFiles} 份。</Typography.Text>{batchResult.results.filter(hasBatchFailure).map(item => <Card key={`failure-${item.fileName}`} size="small" style={{ marginTop: 10, borderColor: 'var(--color-danger-light-4)' }} title={<Space><Tag color="red">导入失败</Tag><Typography.Text bold>{item.fileName}</Typography.Text></Space>}><Typography.Paragraph>项目：{item.projectName || item.proposedProjectName || '未识别项目'}</Typography.Paragraph>{item.errors?.map((error,index)=><Typography.Paragraph key={`file-${index}`} type="error">文件级错误：{formatImportError(error)}</Typography.Paragraph>)}{item.jobs?.filter(job => job.status === 'failed' || Number(job.failedRows ?? 0) > 0 || Boolean(job.errors?.length)).map(job => <div key={`${item.fileName}-${job.kind}`} style={{ marginTop: 8 }}><Space><Tag color="orange">{kindLabels[job.kind] ?? job.kind}</Tag><Typography.Text type="error">成功 {formatNumber(job.successRows ?? null)} 行，失败 {formatNumber(job.failedRows ?? null)} 行</Typography.Text></Space>{job.errors?.length ? <ul style={{ marginTop: 6, marginBottom: 0 }}>{job.errors.map((error,index)=><li key={`${job.kind}-${index}`}><Typography.Text type="error">{formatImportError(error)}</Typography.Text></li>)}</ul> : null}</div>)}</Card>)}{batchResult.results.filter(item => item.status === 'name_change_confirmation_required').map(item => <Typography.Paragraph key={item.fileName} type="warning">名称变更确认：{item.projectName} → {item.proposedProjectName}</Typography.Paragraph>)}</div> : null}</Card>
    {projectId ? <><Card title="文件导入" style={{ marginBottom: 16 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Space wrap>
          <Typography.Text bold>导入类型</Typography.Text><Select value={importKind} options={importKinds} onChange={value => { setImportKind(value as ImportKind); setPreview(undefined); setExecuteResult(undefined) }} style={{ width: 150 }} />
          <input type="file" accept=".csv,.xlsx,.xlsm" onChange={event => selectFile(event.target.files?.[0])} />
          <Button type="primary" loading={previewLoading} disabled={!file} onClick={() => void previewImport()}>预览文件</Button>
        </Space>
        {file ? <Typography.Text type="secondary">已选择：{file.name}（{formatBytes(file.size)}）</Typography.Text> : <Typography.Text type="secondary">请选择 CSV、XLSX 或 XLSM 文件。标准字段表和“项目实施计划表”多页签模板均可识别，系统会按导入类型自动选择 WBS、风险或里程碑页签并转换中文字段。</Typography.Text>}
        {previewError ? <Typography.Text type="error">{previewError}</Typography.Text> : null}
        {previewLoading ? <LoadingState title="正在解析文件" description="请稍候，正在生成预览。" /> : null}
        {preview ? <Card size="small" title={`预览（共 ${preview.totalRows} 行）`}>
          {preview.errors.length ? <div style={{ marginBottom: 12 }}><Typography.Text type="error">发现 {preview.errors.length} 条错误，修正文件后再执行：</Typography.Text><ul>{preview.errors.map((item, index) => <li key={`${item.row ?? 'x'}-${index}`}><Typography.Text type="error">{item.row ? `第 ${item.row} 行：` : ''}{item.message}</Typography.Text></li>)}</ul></div> : null}
          {preview.headers.length ? <><Typography.Text type="secondary">字段映射：{preview.headers.map(header => importHeaderLabels[header] ? `${importHeaderLabels[header]} → ${header}` : header).join('；')}</Typography.Text><Table style={{ marginTop: 8 }} rowKey={record => preview.rows.indexOf(record)} columns={previewColumns} data={preview.rows} pagination={{ pageSize: 5 }} scroll={{ x: true }} /></> : <EmptyState title="文件没有可预览的数据" description="请检查文件是否包含可识别的表头和数据行。" />}
          <Space style={{ marginTop: 12 }}><Button type="primary" loading={executeLoading} disabled={preview.errors.length > 0 || !preview.rows.length} onClick={() => void executeImport()}>执行导入</Button>{preview.errors.length ? <Typography.Text type="secondary">预览无错误后才能执行</Typography.Text> : null}</Space>
        </Card> : null}
        {changePreview ? <Card className="import-change-preview" size="small" title={<Space>{changePreview.batch.baseline?<Tag color="arcoblue">首次基线</Tag>:<Tag color="purple">相对上一成功批次</Tag>}<span>字段级变化预览</span></Space>} extra={<Typography.Text type="secondary">批次 {shortId(changePreview.batch.id)} · ICT-1</Typography.Text>}>
          <div className="import-change-summary"><ChangeStat label="新增" value={changePreview.summary.created} tone="created"/><ChangeStat label="修改" value={changePreview.summary.modified} tone="modified"/><ChangeStat label="清空" value={changePreview.summary.cleared} tone="cleared"/><ChangeStat label="归档" value={changePreview.summary.archived} tone="archived"/><ChangeStat label="关键变化" value={changePreview.summary.bySeverity.critical} tone="critical"/></div>
          <div className="import-change-batch-meta"><span>来源：{changePreview.batch.sourceName}</span><span>基准：{changePreview.batch.baseBatchId?shortId(changePreview.batch.baseBatchId):'无（首次基线）'}</span><Tooltip content={changePreview.batch.sourceChecksum}><span>文件校验：{shortId(changePreview.batch.sourceChecksum)}</span></Tooltip></div>
          {changePreview.errors.length?<div className="import-change-errors"><b>发现 {changePreview.errors.length} 条校验错误，当前批次不可确认</b>{changePreview.errors.map((error,index)=><span key={index}>{error.row?`第 ${error.row} 行：`:''}{error.message}</span>)}</div>:null}
          <Space wrap className="import-change-toolbar"><Typography.Text bold>预览明细</Typography.Text><Select value={changeTypeFilter} onChange={setChangeTypeFilter} style={{width:160}} options={[{label:'仅看本次变化',value:'changed'},{label:'全部（含无变化）',value:'all'},{label:'首次基线',value:'initial'},{label:'新增',value:'created'},{label:'修改',value:'modified'},{label:'清空',value:'cleared'},{label:'归档',value:'archived'}]}/><Typography.Text type="secondary">{visibleChangeItems.length} 项</Typography.Text></Space>
          <Table<ImportChangeItem> rowKey={item=>`${item.businessKey}-${item.sourceRow??'archive'}`} data={visibleChangeItems} pagination={{pageSize:8}} scroll={{x:900}} columns={[{title:'WBS',dataIndex:'businessKey',width:110},{title:'变化语义',dataIndex:'changeType',width:120,render:value=><ChangeTypeTag type={value}/>},{title:'字段变化',width:250,render:(_,item)=><FieldBadges changes={item.changes}/>},{title:'最高等级',dataIndex:'maxSeverity',width:110,render:value=><SeverityTag severity={value}/>},{title:'来源',width:180,render:(_,item)=>item.sourceRow?`${item.sourceSheet??'实施计划'} · 第 ${item.sourceRow} 行`:'完整快照缺行'},{title:'操作',width:90,render:(_,item)=><Button type="text" onClick={()=>setChangeDetail(item)}>查看详情</Button>}]}/>
          {changePreview.summary.bySeverity.critical>0?<Checkbox className="import-change-critical-confirm" checked={confirmCritical} onChange={setConfirmCritical}>我已核对 {changePreview.summary.bySeverity.critical} 项关键字段变化（含清空/归档），确认按完整快照应用</Checkbox>:null}
          <Space style={{marginTop:12}}><Button type="primary" loading={executeLoading} disabled={!changePreview.confirmable||changePreview.batch.status==='succeeded'||(changePreview.summary.bySeverity.critical>0&&!confirmCritical)} onClick={()=>void executeImport()}>{changePreview.batch.status==='succeeded'?'已完成导入':'确认并执行导入'}</Button><Typography.Text type="secondary">预览不会写入当前任务；确认时将复核基准与预览指纹。</Typography.Text></Space>
        </Card>:null}
        {executeResult ? <Typography.Text type="success">执行结果：{statusLabels[executeResult.status] ?? executeResult.status}，成功 {formatNumber(executeResult.successRows)} 行，失败 {formatNumber(executeResult.failedRows)} 行。</Typography.Text> : null}
      </Space>
    </Card></> : null}
    {error ? <Card style={{ marginBottom: 16 }}><Typography.Text type="error">{error}</Typography.Text><Button type="text" onClick={() => void load()}>重新加载</Button></Card> : null}
    <Card title="导入任务列表" extra={<Typography.Text type="secondary">共 {jobs.length} 个任务</Typography.Text>} bodyStyle={{ padding: 0 }}>
      {jobs.length ? <Table<ImportJob> rowKey="id" data={jobs} pagination={{ pageSize: 10, showTotal: true }} scroll={{ x: 1050 }} columns={[
        { title: '类型', dataIndex: 'kind', width: 130, render: value => <Tag color="arcoblue">{kindLabels[value] ?? value}</Tag> },
        { title: '来源', dataIndex: 'sourceName', width: 220, render: value => <Typography.Text bold>{value}</Typography.Text> },
        { title: '状态', dataIndex: 'status', width: 120, render: value => <StatusTag value={value} label={statusLabels[value] ?? value} /> },
        { title: '行数（成功 / 失败）', width: 170, render: (_, item) => `${formatNumber(item.totalRows)}（${formatNumber(item.successRows)} / ${formatNumber(item.failedRows)}）` },
        { title: '错误摘要', dataIndex: 'errors', render: value => <Typography.Text type={value?.length ? 'error' : 'secondary'}>{summarizeErrors(value)}</Typography.Text> },
        { title: '更新时间', dataIndex: 'updatedAt', width: 190, render: value => formatDateTime(value) },
      ]} /> : <EmptyState title="暂无导入任务" description="当前项目还没有登记导入任务，可点击右上角登记。" actionLabel="登记导入任务" onAction={openCreate} />}
    </Card>
    <Modal title="登记导入任务" visible={modalVisible} onCancel={() => setModalVisible(false)} onOk={() => void submit()} confirmLoading={saving} autoFocus={false}><Form form={form} layout="vertical"><Form.Item field="kind" label="导入类型" rules={[{ required: true, message: '请输入导入类型' }, { maxLength: 80, message: '导入类型最多 80 个字符' }]}><Input placeholder="例如：tasks、risks" /></Form.Item><Form.Item field="sourceName" label="来源名称" rules={[{ required: true, message: '请输入来源名称' }, { maxLength: 200, message: '来源名称最多 200 个字符' }]}><Input placeholder="例如：项目台账.xlsx" /></Form.Item></Form></Modal>
    <ChangeDetailDrawer item={changeDetail} batch={changePreview?.batch} onClose={()=>setChangeDetail(undefined)}/>
  </div>
}
const changeLabels:Record<string,string>={initial:'首次基线',unchanged:'无变化',created:'新增',modified:'修改',cleared:'已清空',archived:'已归档'}
const directionLabels:Record<string,string>={increase:'增加',decrease:'减少',postponed:'推后',advanced:'提前',from_empty:'首次补充',to_empty:'清空',state_forward:'状态前进',state_backward:'状态回退',changed:'变更',none:'基线'}
const fieldLabels:Record<string,string>={name:'任务名称',phaseName:'一级模块',description:'补充说明',vendor:'承建方',ownerName:'责任人',plannedStartDate:'开始时间',plannedEndDate:'计划完成时间',status:'当前状态',progress:'完成进度',priority:'优先级',deliverable:'交付物/范围说明',parentWbsCode:'上级 WBS',isCurrent:'当前快照'}
function ChangeStat({label,value,tone}:{label:string;value:number;tone:string}){return <div className={`import-change-stat import-change-stat--${tone}`}><span>{label}</span><b>{value}</b></div>}
function ChangeTypeTag({type}:{type:string}){const colors:Record<string,string>={initial:'arcoblue',unchanged:'gray',created:'green',modified:'orange',cleared:'magenta',archived:'red'};return <Tag color={colors[type]??'gray'}>{changeLabels[type]??type}</Tag>}
function SeverityTag({severity}:{severity:string}){const colors:Record<string,string>={info:'gray',low:'green',medium:'orange',high:'orangered',critical:'red'};const labels:Record<string,string>={info:'提示',low:'低',medium:'中',high:'高',critical:'关键'};return <Tag color={colors[severity]??'gray'}>{labels[severity]??severity}</Tag>}
function FieldBadges({changes}:{changes:ImportFieldChange[]}){if(!changes.length)return <Typography.Text type="secondary">无字段变化</Typography.Text>;return <Space wrap>{changes.slice(0,3).map(change=><Tooltip key={change.fieldKey} content={`${displayValue(change.oldDisplay)} → ${displayValue(change.newDisplay)} · ${directionLabels[change.direction]??change.direction}`}><Tag className={change.changeType==='cleared'?'import-change-field--cleared':''}>{fieldLabels[change.fieldKey]??change.fieldKey}</Tag></Tooltip>)}{changes.length>3?<Tag>+{changes.length-3}</Tag>:null}</Space>}
function ChangeDetailDrawer({item,batch,onClose}:{item?:ImportChangeItem;batch?:ImplementationPlanChangePreview['batch'];onClose:()=>void}){return <Drawer width={600} title={item?`变化详情 · WBS ${item.businessKey}`:'变化详情'} visible={Boolean(item)} onCancel={onClose} footer={null}><div className="import-change-detail-meta"><ChangeTypeTag type={item?.changeType??'unchanged'}/><SeverityTag severity={item?.maxSeverity??'info'}/><span>来源批次：{batch?shortId(batch.id):'—'}</span><span>来源文件：{batch?.sourceName??'—'}</span><span>来源位置：{item?.sourceRow?`${item.sourceSheet??'实施计划'} 第 ${item.sourceRow} 行`:'完整快照缺行（归档）'}</span></div>{item?.changes.length?<div className="import-change-detail-list">{item.changes.map(change=><article key={`${change.fieldKey}-${change.changeType}`} className={`import-change-detail import-change-detail--${change.changeType}`}><header><b>{fieldLabels[change.fieldKey]??change.fieldKey}</b><Space><Tag>{directionLabels[change.direction]??change.direction}</Tag><SeverityTag severity={change.severity}/></Space></header><div className="import-change-values"><span><small>原值</small><strong>{displayValue(change.oldDisplay)}</strong></span><i aria-hidden>→</i><span><small>{change.changeType==='cleared'?'清空后':'新值'}</small><strong>{change.changeType==='cleared'?'已清空':displayValue(change.newDisplay)}</strong></span></div></article>)}</div>:<EmptyState title="没有字段变化" description="该任务在本次批次中保持不变。"/>}</Drawer>}
function displayValue(value:string|null|undefined){return value==null||value===''?'未填写':value}
function shortId(value:string){return value.length>12?`${value.slice(0,8)}…`:value}
function formatNumber(value: number | null) { return value === null ? '—' : String(value) }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB` }
function summarizeErrors(errors: ImportJob['errors']) { if (!errors?.length) return '—'; const first = formatImportError(errors[0]!); return errors.length > 1 ? `${first}（另有 ${errors.length - 1} 条）` : first }
function formatImportError(error: { row?: number; message: string }) { const labels: Record<string,string> = { approval_date_range_invalid:'计划开始日期晚于计划完成日期', import_project_not_matched:'未找到匹配项目', import_project_name_not_found:'未识别到项目名称', import_header_not_found:'未识别到对应页签表头', import_format_unsupported:'不支持的文件格式' }; const message = labels[error.message] ?? error.message; return `${error.row ? `Excel 第 ${error.row} 行：` : ''}${message}` }
function hasBatchFailure(item: { status?:string; errors?:Array<{row?:number;message:string}>; jobs?:Array<{status:string;failedRows?:number|null;errors?:Array<{row?:number;message:string}>}> }) { return item.status === 'failed' || Boolean(item.errors?.length) || Boolean(item.jobs?.some(job => job.status === 'failed' || Number(job.failedRows ?? 0) > 0 || Boolean(job.errors?.length))) }
function formatDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false }) }
function formatElapsed(seconds: number) { const minutes = Math.floor(seconds / 60); const rest = seconds % 60; return minutes ? `${minutes}分${String(rest).padStart(2, '0')}秒` : `${rest}秒` }

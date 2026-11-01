import { Button, Card, DatePicker, Drawer, Form, Grid, Input, InputNumber, Message, Modal, Select, Space, Switch, Table, Tag, Typography } from '@arco-design/web-react'
import { IconArchive, IconDelete, IconEdit, IconFile, IconFolder, IconFolderAdd, IconRefresh, IconSearch, IconStorage } from '@arco-design/web-react/icon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { createKnowledgeFolder, deleteKnowledgeFolder, downloadKnowledgeDocument, embedKnowledgeVersion, getKnowledgeDocument, getKnowledgeWorkspace, listKnowledgeDocuments, listKnowledgeDocumentVersions, parseKnowledgeVersion, searchKnowledgeContent, searchKnowledgeHybrid, updateKnowledgeDocument, updateKnowledgeFolder, uploadKnowledgeDocument, uploadKnowledgeDocumentVersion, type KnowledgeContentSearchItem, type KnowledgeDocument, type KnowledgeDocumentStatus, type KnowledgeDocumentVersion, type KnowledgeFolder, type KnowledgeFolderInput, type KnowledgeHybridSearchItem, type KnowledgeSearchMode, type KnowledgeWorkspace } from '../../api/projects.ts'
import { EmptyState, ErrorState, LoadingState } from '../../components/feedback/index.ts'
import { StatCard, StatusTag } from '../../components/ui/index.ts'
import { ApiError } from '../../lib/api-client.ts'

const { Row, Col } = Grid
const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '草稿', value: 'draft' },
  { label: '审核中', value: 'reviewing' },
  { label: '已确认', value: 'confirmed' },
  { label: '已归档', value: 'archived' },
  { label: '已废止', value: 'obsolete' },
]

export function ProjectKnowledgePage() {
  const { projectId = '' } = useParams<{ projectId: string }>()
  const [params, setParams] = useSearchParams()
  const [workspace, setWorkspace] = useState<KnowledgeWorkspace>()
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [searchResults, setSearchResults] = useState<Array<KnowledgeContentSearchItem | KnowledgeHybridSearchItem>>([])
  const [searchTotal, setSearchTotal] = useState(0)
  const [searchWarning, setSearchWarning] = useState<string>()
  const [indexing, setIndexing] = useState<string>()
  const [parsing, setParsing] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [search, setSearch] = useState(params.get('q') ?? '')
  const [selected, setSelected] = useState<KnowledgeDocument | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [folderModal, setFolderModal] = useState<{ mode: 'new' | 'edit'; folder?: KnowledgeFolder; parentId?: string | null } | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [versionTarget, setVersionTarget] = useState<KnowledgeDocument | null>(null)
  const [versions, setVersions] = useState<KnowledgeDocumentVersion[]>([])
  const requestId = useRef(0)
  const detailRequestId = useRef(0)
  const folderId = params.get('folderId') ?? 'all'
  const rawStatus = params.get('status') ?? 'all'
  const status = statusOptions.some(option => option.value === rawStatus) ? rawStatus : 'all'
  const fileType = params.get('fileType')?.trim() ?? ''
  const includeArchived = params.get('includeArchived') === 'true'
  const updatedFrom = params.get('updatedFrom') ?? ''
  const updatedTo = params.get('updatedTo') ?? ''
  const query = params.get('q')?.trim() ?? ''
  const focusDocumentId = params.get('documentId')?.trim() ?? ''
  const focusVersionId = params.get('versionId')?.trim() ?? ''
  const rawMode = params.get('mode')
  const searchMode: KnowledgeSearchMode = rawMode === 'keyword' || rawMode === 'semantic' ? rawMode : 'hybrid'
  const minScore = Number(params.get('minScore') ?? '0.45')
  const contentMode = query.length >= 2
  const flatFolders = useMemo(() => flattenFolders(workspace?.folders ?? []), [workspace])
  const selectedFolder = flatFolders.find(folder => folder.id === folderId)

  const setFilter = useCallback((key: string, value: string, replace = false) => {
    const next = new URLSearchParams(params)
    if (!value || value === 'all' || value === 'false') next.delete(key)
    else next.set(key, value)
    setParams(next, { replace })
  }, [params, setParams])

  useEffect(() => { requestId.current += 1; detailRequestId.current += 1; setWorkspace(undefined); setDocuments([]); setSearchResults([]); setSearchTotal(0); setSelected(null); setFolderModal(null); setUploadOpen(false); setVersionTarget(null); setVersions([]); setError(undefined); setLoading(true) }, [projectId])
  useEffect(() => setSearch(params.get('q') ?? ''), [params])
  useEffect(() => {
    const next = new URLSearchParams(params)
    let changed = false
    if (params.get('status') && !statusOptions.some(option => option.value === params.get('status'))) { next.delete('status'); changed = true }
    if (params.get('includeArchived') && !['true', 'false'].includes(params.get('includeArchived')!)) { next.delete('includeArchived'); changed = true }
    if (['archived', 'obsolete'].includes(params.get('status') ?? '') && !includeArchived) { next.set('includeArchived', 'true'); changed = true }
    if (changed) setParams(next, { replace: true })
  }, [includeArchived, params, setParams])
  useEffect(() => {
    const timer = window.setTimeout(() => { if (search.trim() !== query) setFilter('q', search.trim(), true) }, 250)
    return () => window.clearTimeout(timer)
  }, [query, search, setFilter])

  const load = useCallback(async () => {
    const current = ++requestId.current
    setLoading(true); setError(undefined)
    try {
      const nextWorkspace = await getKnowledgeWorkspace(projectId)
      if (current !== requestId.current) return
      setWorkspace(nextWorkspace)
      const validFolders = flattenFolders(nextWorkspace.folders)
      const validFolderId = folderId === 'all' || validFolders.some(folder => folder.id === folderId) ? folderId : 'all'
      if (validFolderId !== folderId) setFilter('folderId', 'all', true)
      const filters = {
        ...(query ? { q: query } : {}),
        ...(validFolderId !== 'all' ? { folderId: validFolderId } : {}),
        ...(status !== 'all' ? { status } : {}),
        ...(fileType ? { fileType } : {}),
        ...(includeArchived ? { includeArchived: 'true' } : {}),
      }
      if (contentMode) {
        const searchFilters = {
          q: query,
          ...(validFolderId !== 'all' ? { folderId: validFolderId } : {}),
          ...(status !== 'all' && status !== 'obsolete' ? { status } : {}),
          ...(fileType ? { fileType } : {}),
          ...(updatedFrom ? { updatedFrom } : {}),
          ...(updatedTo ? { updatedTo } : {}),
          ...(includeArchived ? { includeArchived: 'true' } : {}),
        }
        const result = searchMode === 'keyword' ? await searchKnowledgeContent(projectId, searchFilters) : await searchKnowledgeHybrid(projectId, { ...searchFilters, mode: searchMode, minScore })
        if (current !== requestId.current) return
        setSearchResults(result.items); setSearchTotal(result.total); setSearchWarning('degraded' in result && result.degraded ? '语义服务暂不可用，已自动使用关键词结果。' : undefined); setDocuments([])
      } else {
        const nextDocuments = await listKnowledgeDocuments(projectId, filters)
        if (current !== requestId.current) return
        setDocuments(nextDocuments); setSearchResults([]); setSearchTotal(0); setSearchWarning(undefined)
      }
    } catch (reason) {
      if (current === requestId.current) setError(reason instanceof ApiError ? reason.message : '知识库加载失败')
    } finally {
      if (current === requestId.current) setLoading(false)
    }
  }, [contentMode, fileType, folderId, includeArchived, minScore, projectId, query, searchMode, setFilter, status, updatedFrom, updatedTo])
  useEffect(() => { void load() }, [load])
  useEffect(()=>{if(!focusDocumentId)return;const current=++detailRequestId.current;setDetailLoading(true);Promise.all([getKnowledgeDocument(projectId,focusDocumentId),listKnowledgeDocumentVersions(projectId,focusDocumentId)]).then(([detail,history])=>{if(current!==detailRequestId.current)return;setSelected(detail);setVersions(history);if(focusVersionId&&!history.some(item=>item.id===focusVersionId))Message.warning('引用版本已不存在，已展示文档当前信息')}).catch(reason=>current===detailRequestId.current&&Message.error(reason instanceof ApiError?reason.message:'引用文档加载失败')).finally(()=>current===detailRequestId.current&&setDetailLoading(false))},[focusDocumentId,focusVersionId,projectId])

  useEffect(() => {
    if (!workspace || folderId === 'all') return
    if (!flatFolders.some(folder => folder.id === folderId)) setFilter('folderId', 'all', true)
  }, [flatFolders, folderId, setFilter, workspace])

  const openDocument = async (document: KnowledgeDocument) => {
    const current = ++detailRequestId.current
    setSelected(document); setDetailLoading(true)
    try { const detail = await getKnowledgeDocument(projectId, document.id); if (current === detailRequestId.current) setSelected(detail) }
    catch (reason) { if (current === detailRequestId.current) Message.error(reason instanceof ApiError ? reason.message : '文档详情加载失败') }
    finally { if (current === detailRequestId.current) setDetailLoading(false) }
  }
  const openSearchResult = async (result: KnowledgeContentSearchItem | KnowledgeHybridSearchItem) => {
    const current = ++detailRequestId.current
    setDetailLoading(true); setVersions([])
    try { const [detail, history] = await Promise.all([getKnowledgeDocument(projectId, result.documentId), listKnowledgeDocumentVersions(projectId, result.documentId)]); if (current === detailRequestId.current) { setSelected(detail); setVersions(history) } }
    catch (reason) { if (current === detailRequestId.current) Message.error(reason instanceof ApiError ? reason.message : '文档详情加载失败') }
    finally { if (current === detailRequestId.current) setDetailLoading(false) }
  }
  const closeDocument = () => { detailRequestId.current += 1; setSelected(null); setDetailLoading(false); setVersions([]) }
  const embedCurrentVersion = async () => {
    const current = versions.find(version => version.isCurrent); if (!selected || !current) return Message.warning('请先加载当前版本')
    setIndexing(current.id)
    try { const result = await embedKnowledgeVersion(projectId, selected.id, current.id); Message.success(`向量化完成：生成 ${result.generated}，复用 ${result.reused}`); await load(); setSelected(await getKnowledgeDocument(projectId, selected.id)) }
    catch (reason) { Message.error(reason instanceof ApiError ? reason.message : '向量化失败') }
    finally { setIndexing(undefined) }
  }
  const parseDocument = async (document: KnowledgeDocument) => {
    const current = selected?.id === document.id ? versions.find(version => version.isCurrent) : undefined
    if (!current) {
      try {
        const history = await listKnowledgeDocumentVersions(projectId, document.id)
        const latest = history.find(version => version.isCurrent)
        if (!latest) return Message.warning('请先加载当前版本')
        setParsing(document.id)
        const result = await parseKnowledgeVersion(projectId, document.id, latest.id)
        Message.success(`解析完成：生成 ${result.chunkCount} 个分段`)
      } catch (reason) { Message.error(reason instanceof ApiError ? reason.message : '解析失败') }
      finally { setParsing(undefined); await load() }
      return
    }
    setParsing(document.id)
    try { const result = await parseKnowledgeVersion(projectId, document.id, current.id); Message.success(`解析完成：生成 ${result.chunkCount} 个分段`); await load(); setSelected(await getKnowledgeDocument(projectId, document.id)); setVersions(await listKnowledgeDocumentVersions(projectId, document.id)) }
    catch (reason) { Message.error(reason instanceof ApiError ? reason.message : '解析失败') }
    finally { setParsing(undefined) }
  }
  const parseCurrentVersion = () => selected ? parseDocument(selected) : Promise.resolve()
  const openVersions = async (document: KnowledgeDocument) => { const current = ++detailRequestId.current; const targetProject = projectId; setSelected(document); setVersions([]); setDetailLoading(true); try { const [detail, history] = await Promise.all([getKnowledgeDocument(projectId, document.id), listKnowledgeDocumentVersions(projectId, document.id)]); if (current === detailRequestId.current && targetProject === projectId) { setSelected(detail); setVersions(history) } } catch (reason) { if (current === detailRequestId.current) Message.error(reason instanceof ApiError ? reason.message : '版本历史加载失败') } finally { if (current === detailRequestId.current) setDetailLoading(false) } }
  const download = async (document: KnowledgeDocument, versionId?: string) => { try { await downloadKnowledgeDocument(projectId, document.id, versionId); Message.success('下载已开始') } catch (reason) { Message.error(reason instanceof ApiError ? reason.message : '文档下载失败') } }
  const changeStatus = async (document: KnowledgeDocument, status: KnowledgeDocumentStatus) => { const restoreStatus = document.metadata.statusBeforeArchive; const desiredStatus = status === 'draft' && document.status === 'archived' && typeof restoreStatus === 'string' && ['draft','reviewing','confirmed','obsolete'].includes(restoreStatus) ? restoreStatus as KnowledgeDocumentStatus : status; try { await updateKnowledgeDocument(projectId, document.id, { status: desiredStatus }); Message.success(desiredStatus === 'archived' ? '文档已归档' : '文档已恢复'); if (selected?.id === document.id) setSelected(await getKnowledgeDocument(projectId, document.id)); await load() } catch (reason) { Message.error(reason instanceof ApiError ? reason.message : '文档状态更新失败') } }
  const removeFolder = (folder: KnowledgeFolder) => Modal.confirm({
    title: '删除目录',
    content: `确定删除“${folder.path}”吗？仅空目录可以删除。`,
    okButtonProps: { status: 'danger' },
    onOk: async () => {
      try { setFolderBusy(true); await deleteKnowledgeFolder(projectId, folder.id); Message.success('目录已删除'); if (folderId === folder.id) setFilter('folderId', 'all', true); else await load() }
      catch (reason) { Message.error(folderErrorMessage(reason, '删除目录失败')) }
      finally { setFolderBusy(false) }
    },
  })

  if (loading && !workspace) return <LoadingState title="正在加载项目知识库" description="正在获取目录结构和文档台账。" />
  if (error && !workspace) return <ErrorState description={error} onRetry={load} />
  const summary = workspace?.summary ?? { folders: 0, documents: 0, activeDocuments: 0, archivedDocuments: 0, storageBytes: 0 }

  return <div className="knowledge-page">
    <header className="knowledge-page__heading">
      <div><Typography.Title heading={3}>项目知识库</Typography.Title><Typography.Paragraph type="secondary">集中管理项目目录和文档台账，为后续版本管理与项目智能助手提供可信资料源。</Typography.Paragraph></div>
      <Space><Button icon={<IconRefresh />} loading={loading} onClick={load}>刷新</Button><Button type="primary" icon={<IconFolderAdd />} onClick={() => setFolderModal({ mode: 'new', parentId: selectedFolder?.id ?? null })}>新建目录</Button><Button type="primary" onClick={() => setUploadOpen(true)}>上传文档</Button></Space>
    </header>
    {error ? <Card className="knowledge-page__warning"><Typography.Text type="error">{error}</Typography.Text><Button type="text" onClick={load}>重新加载</Button></Card> : null}
    <Row gutter={16} className="knowledge-page__stats">
      <Col span={6}><StatCard title="目录总数" value={summary.folders} icon={<IconFolder />} description="项目标准目录及自建目录" /></Col>
      <Col span={6}><StatCard title="文档总数" value={summary.documents} icon={<IconFile />} description={`当前筛选显示 ${documents.length} 份`} tone="green" /></Col>
      <Col span={6}><StatCard title="已归档文档" value={summary.archivedDocuments} icon={<IconArchive />} description="保留历史但默认隐藏" tone="orange" /></Col>
      <Col span={6}><StatCard title="逻辑存储量" value={formatBytes(summary.storageBytes)} icon={<IconStorage />} description={`${summary.activeDocuments} 份活动文档`} tone="purple" /></Col>
    </Row>
    <div className="knowledge-workspace">
      <Card className="knowledge-folder-panel" title={<Space><IconFolder /><span>文档目录</span></Space>} extra={<Button size="mini" type="text" icon={<IconFolderAdd />} onClick={() => setFolderModal({ mode: 'new', parentId: selectedFolder?.id ?? null })}>新增</Button>}>
        <button type="button" className={`knowledge-folder-row knowledge-folder-row--root${folderId === 'all' ? ' is-active' : ''}`} onClick={() => setFilter('folderId', 'all')}><IconFolder /><span>全部文档</span><em>{summary.documents}</em></button>
        <FolderTree folders={workspace?.folders ?? []} selectedId={folderId} busy={folderBusy} onSelect={id => setFilter('folderId', id)} onAdd={parentId => setFolderModal({ mode: 'new', parentId })} onEdit={folder => setFolderModal({ mode: 'edit', folder })} onDelete={removeFolder} />
      </Card>
      <div className="knowledge-document-panel">
        <Card className="knowledge-filters">
          <div className="knowledge-filters__main"><Select value={searchMode} options={[{label:'混合检索',value:'hybrid'},{label:'语义检索',value:'semantic'},{label:'关键词',value:'keyword'}]} onChange={value => setFilter('mode', value)} style={{width:120}} /><Input allowClear prefix={<IconSearch />} placeholder="搜索文档内容（至少2个字符）" value={search} onChange={setSearch} style={{ width: 320 }} /><Select value={status} options={statusOptions} onChange={value => setFilter('status', value)} style={{ width: 140 }} /><Input allowClear placeholder="文件类型，如 pdf" value={fileType} onChange={value => setFilter('fileType', value.trim())} style={{ width: 150 }} />{contentMode ? <><DatePicker value={updatedFrom || undefined} onChange={value => setFilter('updatedFrom', value ?? '')} placeholder="更新起始日" style={{ width: 145 }} /><DatePicker value={updatedTo || undefined} onChange={value => setFilter('updatedTo', value ?? '')} placeholder="更新截止日" style={{ width: 145 }} />{searchMode !== 'keyword' ? <InputNumber min={0} max={1} step={0.05} precision={2} value={minScore} onChange={value => setFilter('minScore', String(value ?? 0.45))} prefix="阈值" style={{width:120}} /> : null}</> : null}<Space><Switch checked={includeArchived} onChange={checked => setFilter('includeArchived', String(checked))} /><Typography.Text type="secondary">包含已归档文档</Typography.Text></Space></div>
          <div className="knowledge-filters__summary"><Typography.Text type="secondary">当前位置</Typography.Text><Typography.Text bold>{selectedFolder?.path ?? '全部文档'}</Typography.Text><Tag>{documents.length} 份</Tag></div>
        </Card>
        {searchWarning ? <Card className="knowledge-page__warning"><Typography.Text type="warning">{searchWarning}</Typography.Text></Card> : null}
        <Card className="knowledge-table-card" title={contentMode ? '内容检索结果' : '文档台账'} extra={<Typography.Text type="secondary">{contentMode ? `命中 ${searchTotal} 个内容分段，结果均来自当前版本` : '支持上传、下载、版本历史与逻辑归档'}</Typography.Text>}>
          {contentMode ? (searchResults.length ? <div className="knowledge-search-results">{searchResults.map(item => <button type="button" className="knowledge-search-result" key={item.chunkId} onClick={() => void openSearchResult(item)}><div className="knowledge-search-result__heading"><span className={`knowledge-file-icon knowledge-file-icon--${fileTone(item.fileType)}`}>{fileLabel(item.fileType)}</span><div><b>{item.documentName}</b><small>{item.originalName} · {item.versionNumber}</small></div><StatusTag value={item.status} /></div><p><HighlightedSnippet text={item.snippet} terms={item.highlights} /></p><div className="knowledge-search-result__meta">{'matchedBy' in item ? item.matchedBy.map(source => <Tag key={source} color={source === 'semantic' ? 'purple' : 'blue'}>{source === 'semantic' ? '语义' : '关键词'}</Tag>) : <Tag color="blue">关键词</Tag>}{'score' in item ? <Tag color="green">相关度 {(item.score * 100).toFixed(1)}%</Tag> : null}<span>{item.folderPath ?? '未分类'}</span>{item.pageNumber ? <Tag>第 {item.pageNumber} 页</Tag> : null}{item.sectionPath ? <Tag>{item.sectionPath}</Tag> : null}<span>{formatDateTime(item.updatedAt)}</span></div></button>)}</div> : <EmptyState title="没有找到匹配内容" description="请尝试更换关键词、目录或筛选条件。" />) : documents.length ? <Table rowKey="id" data={documents} pagination={{ pageSize: 10, showTotal: true }} columns={[
            { title: '文档名称', dataIndex: 'name', render: (_, item) => <button type="button" className="knowledge-document-name" onClick={() => void openDocument(item)}><span className={`knowledge-file-icon knowledge-file-icon--${fileTone(item.fileType)}`}>{fileLabel(item.fileType)}</span><span><b>{item.name}</b><small>{item.originalName}</small></span></button> },
            { title: '目录', dataIndex: 'folderId', render: value => flatFolders.find(folder => folder.id === value)?.path ?? '未分类' },
            { title: '类型 / 大小', render: (_, item) => <span>{item.fileType.toUpperCase()} · {formatBytes(item.fileSize ?? 0)}</span> },
            { title: '版本', dataIndex: 'version' },
            { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> },
            { title: '解析 / 索引', render: (_, item) => <Space size="small" wrap><ProcessingStatusTag label="解析" value={item.parseStatus} /><ProcessingStatusTag label="索引" value={item.indexStatus} />{item.parseStatus === 'failed' ? <Button type="text" size="small" loading={parsing === item.id} onClick={() => void parseDocument(item)}>重试解析</Button> : null}</Space> },
             { title: '更新时间', dataIndex: 'updatedAt', render: value => formatDateTime(value) },
            { title: '操作', render: (_, item) => <Space wrap><Button type="text" onClick={() => void openVersions(item)}>详情/版本</Button><Button type="text" onClick={() => void download(item)}>下载</Button><Button type="text" onClick={() => setVersionTarget(item)}>上传新版本</Button><Button type="text" status={item.status === 'archived' ? 'default' : 'danger'} onClick={() => void changeStatus(item, item.status === 'archived' ? 'draft' : 'archived')}>{item.status === 'archived' ? '恢复' : '归档'}</Button></Space> },
          ]} /> : <EmptyState title={hasFilters(query, folderId, status, fileType, includeArchived) ? '当前条件下没有文档' : '知识库暂时没有文档'} description={hasFilters(query, folderId, status, fileType, includeArchived) ? '请调整目录或筛选条件后重试。' : '目录工作台已经就绪，可点击页面右上角上传首份文档。'} actionLabel={!hasFilters(query, folderId, status, fileType, includeArchived) ? '上传文档' : undefined} onAction={!hasFilters(query, folderId, status, fileType, includeArchived) ? () => setUploadOpen(true) : undefined} />}
        </Card>
      </div>
    </div>
    <DocumentDetail item={selected} loading={detailLoading} versions={versions} indexing={Boolean(indexing)} parsing={Boolean(parsing)} onParse={() => void parseCurrentVersion()} folderPath={selected ? flatFolders.find(folder => folder.id === selected.folderId)?.path : undefined} onEmbed={() => void embedCurrentVersion()} onClose={closeDocument} onDownload={versionId => selected ? void download(selected, versionId) : undefined} onNewVersion={() => selected && setVersionTarget(selected)} onStatus={status => selected ? void changeStatus(selected, status) : undefined} />
    <DocumentUploadModal projectId={projectId} visible={uploadOpen} folders={flatFolders} defaultFolderId={selectedFolder?.id} onClose={() => setUploadOpen(false)} onSaved={async () => { setUploadOpen(false); await load() }} />
    <VersionUploadModal projectId={projectId} document={versionTarget} onClose={() => setVersionTarget(null)} onSaved={async () => { const target = versionTarget; setVersionTarget(null); await load(); if (target) await openVersions(target) }} />
    <FolderFormModal projectId={projectId} state={folderModal} folders={flatFolders} onClose={() => setFolderModal(null)} onSaved={async () => { setFolderModal(null); await load() }} />
  </div>
}

function ProcessingStatusTag({ label, value }: { label: string; value: KnowledgeDocument['parseStatus'] }) {
  const labels: Record<KnowledgeDocument['parseStatus'], string> = { pending: '待处理', processing: '处理中', completed: '已完成', failed: '失败' }
  const colors: Record<KnowledgeDocument['parseStatus'], string> = { pending: 'gray', processing: 'arcoblue', completed: 'green', failed: 'red' }
  return <Tag color={colors[value]}>{label}：{labels[value]}</Tag>
}
function HighlightedSnippet({ text, terms }: { text: string; terms: string[] }) {
  const normalizedTerms = [...terms].sort((a, b) => b.length - a.length).filter(Boolean)
  if (!normalizedTerms.length) return <>{text}</>
  const pattern = new RegExp(`(${normalizedTerms.map(escapeRegExp).join('|')})`, 'giu')
  return <>{text.split(pattern).map((part, index) => normalizedTerms.some(term => term.toLocaleLowerCase() === part.toLocaleLowerCase()) ? <mark key={`${index}-${part}`}>{part}</mark> : <span key={`${index}-${part}`}>{part}</span>)}</>
}

function FolderTree({ folders, selectedId, busy, onSelect, onAdd, onEdit, onDelete, depth = 0 }: { folders: KnowledgeFolder[]; selectedId: string; busy: boolean; onSelect: (id: string) => void; onAdd: (parentId: string) => void; onEdit: (folder: KnowledgeFolder) => void; onDelete: (folder: KnowledgeFolder) => void; depth?: number }) {
  return <>{folders.map(folder => <div key={folder.id}>
    <div className={`knowledge-folder-row${selectedId === folder.id ? ' is-active' : ''}`} style={{ paddingLeft: 10 + depth * 16 }}>
      <button type="button" className="knowledge-folder-row__select" onClick={() => onSelect(folder.id)} title={folder.path}><IconFolder /><span>{folder.name}</span><em>{folder.documentCount ?? 0}</em></button>
      <span className="knowledge-folder-row__actions"><Button size="mini" type="text" icon={<IconFolderAdd />} aria-label={`在${folder.name}下新建目录`} onClick={() => onAdd(folder.id)} /><Button size="mini" type="text" icon={<IconEdit />} aria-label={`编辑${folder.name}`} onClick={() => onEdit(folder)} /><Button size="mini" type="text" status="danger" icon={<IconDelete />} aria-label={`删除${folder.name}`} disabled={busy} onClick={() => onDelete(folder)} /></span>
    </div>
    {folder.children.length ? <FolderTree folders={folder.children} selectedId={selectedId} busy={busy} onSelect={onSelect} onAdd={onAdd} onEdit={onEdit} onDelete={onDelete} depth={depth + 1} /> : null}
  </div>)}</>
}

function FolderFormModal({ projectId, state, folders, onClose, onSaved }: { projectId: string; state: { mode: 'new' | 'edit'; folder?: KnowledgeFolder; parentId?: string | null } | null; folders: KnowledgeFolder[]; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm(); const [saving, setSaving] = useState(false)
  useEffect(() => { form.resetFields(); if (state?.mode === 'new') form.setFieldsValue({ parentId: state.parentId ?? undefined, sortOrder: 0 }); if (state?.mode === 'edit' && state.folder) form.setFieldsValue({ name: state.folder.name, parentId: state.folder.parentId ?? undefined, sortOrder: state.folder.sortOrder }) }, [form, state])
  if (!state) return null
  const unavailable = state.folder ? new Set([state.folder.id, ...collectDescendantIds(state.folder)]) : new Set<string>()
  const submit = async () => {
    try { const values = await form.validate() as KnowledgeFolderInput; const input = state.mode === 'edit' ? { ...values, parentId: values.parentId ?? null } : values; setSaving(true); if (state.mode === 'new') await createKnowledgeFolder(projectId, input); else if (state.folder) await updateKnowledgeFolder(projectId, state.folder.id, input); Message.success(state.mode === 'new' ? '目录已创建' : '目录已更新'); await onSaved() }
    catch (reason) { if (!(reason instanceof Error && reason.message.includes('required'))) Message.error(folderErrorMessage(reason, '保存目录失败')) }
    finally { setSaving(false) }
  }
  return <Modal title={state.mode === 'new' ? '新建知识库目录' : '编辑知识库目录'} visible onCancel={onClose} onOk={submit} confirmLoading={saving} autoFocus={false}><Form form={form} layout="vertical"><Form.Item field="name" label="目录名称" rules={[{ required: true, message: '请输入目录名称' }, { maxLength: 120, message: '目录名称最多120个字符' }]}><Input placeholder="请输入目录名称" /></Form.Item><Form.Item field="parentId" label="上级目录"><Select allowClear placeholder="不选择则创建为一级目录" options={folders.filter(folder => !unavailable.has(folder.id)).map(folder => ({ label: folder.path, value: folder.id }))} /></Form.Item><Form.Item field="sortOrder" label="排序"><InputNumber min={0} max={9999} /></Form.Item></Form></Modal>
}

function DocumentDetail({ item, loading, versions, indexing, parsing, folderPath, onParse, onEmbed, onClose, onDownload, onNewVersion, onStatus }: { item: KnowledgeDocument | null; loading: boolean; versions: KnowledgeDocumentVersion[]; indexing: boolean; parsing: boolean; folderPath?: string; onParse: () => void; onEmbed: () => void; onClose: () => void; onDownload: (versionId?: string) => void; onNewVersion: () => void; onStatus: (status: KnowledgeDocumentStatus) => void }) {
  return <Drawer width={620} title="文档详情与版本" visible={Boolean(item)} onCancel={onClose} footer={item ? <Space><Button loading={parsing} disabled={item.status === 'archived' || item.status === 'obsolete'} onClick={onParse}>{item.parseStatus === 'failed' ? '重试解析' : '解析文档'}</Button><Button type="primary" loading={indexing} disabled={item.status === 'archived' || item.status === 'obsolete'} onClick={onEmbed}>生成语义索引</Button><Button onClick={() => onDownload()}>下载当前版本</Button><Button onClick={onNewVersion}>上传新版本</Button><Button status={item.status === 'archived' ? 'default' : 'danger'} onClick={() => onStatus(item.status === 'archived' ? 'draft' : 'archived')}>{item.status === 'archived' ? '恢复文档' : '归档文档'}</Button></Space> : null}>{loading ? <LoadingState title="正在加载文档详情" /> : item ? <div className="knowledge-detail"><div className="knowledge-detail__title"><span className={`knowledge-file-icon knowledge-file-icon--${fileTone(item.fileType)}`}>{fileLabel(item.fileType)}</span><div><Typography.Title heading={5}>{item.name}</Typography.Title><Space><StatusTag value={item.status} /><ProcessingStatusTag label="解析" value={item.parseStatus} /><ProcessingStatusTag label="索引" value={item.indexStatus} /><Tag>{item.version}</Tag></Space></div></div>{[['原文件名', item.originalName], ['所属目录', folderPath ?? '未分类'], ['文件类型', item.fileType.toUpperCase()], ['MIME 类型', item.mimeType ?? '—'], ['文件大小', formatBytes(item.fileSize ?? 0)], ['校验和', item.checksum ?? '—'], ['创建时间', formatDateTime(item.createdAt)], ['更新时间', formatDateTime(item.updatedAt)]].map(([label, value]) => <div className="knowledge-detail__row" key={label}><Typography.Text type="secondary">{label}</Typography.Text><Typography.Text>{value}</Typography.Text></div>)}<div className="knowledge-version-list"><Typography.Title heading={6}>版本历史</Typography.Title>{versions.map(version => <div className="knowledge-version-row" key={version.id}><div><Space><b>{version.versionNumber}</b>{version.isCurrent ? <Tag color="green">当前版本</Tag> : null}</Space><small>{version.originalName ?? item.originalName} · {formatBytes(version.fileSize ?? 0)} · {formatDateTime(version.createdAt)}</small><Typography.Text type="secondary">{version.changeSummary || '无变更说明'}</Typography.Text></div><Button type="text" onClick={() => onDownload(version.id)}>下载</Button></div>)}</div></div> : null}</Drawer>
}

function DocumentUploadModal({ projectId, visible, folders, defaultFolderId, onClose, onSaved }: { projectId: string; visible: boolean; folders: KnowledgeFolder[]; defaultFolderId?: string; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm(); const [file, setFile] = useState<File>(); const [saving, setSaving] = useState(false)
  useEffect(() => { if (visible) { form.resetFields(); form.setFieldsValue({ folderId: defaultFolderId, status: 'draft' }); setFile(undefined) } }, [defaultFolderId, form, visible])
  const submit = async () => { try { const values = await form.validate(); if (!file) return Message.warning('请选择上传文件'); setSaving(true); await uploadKnowledgeDocument(projectId, { file, ...values }); Message.success('文档上传成功'); await onSaved() } catch (reason) { if (!(reason instanceof Error && reason.message.includes('required'))) Message.error(reason instanceof ApiError ? reason.message : '文档上传失败') } finally { setSaving(false) } }
  return <Modal title="上传文档" visible={visible} onCancel={onClose} onOk={submit} confirmLoading={saving} autoFocus={false}><Form form={form} layout="vertical"><Form.Item label="选择文件" required><input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.zip,.png,.jpg,.jpeg" onChange={event => setFile(event.target.files?.[0])} />{file ? <Typography.Text type="secondary">{file.name} · {formatBytes(file.size)}</Typography.Text> : null}</Form.Item><Form.Item field="name" label="文档名称"><Input placeholder="留空则使用文件名" /></Form.Item><Form.Item field="folderId" label="所属目录"><Select allowClear options={folders.map(folder => ({ label: folder.path, value: folder.id }))} /></Form.Item><Form.Item field="status" label="状态"><Select options={statusOptions.filter(option => option.value !== 'all')} /></Form.Item><Form.Item field="changeSummary" label="版本说明"><Input.TextArea placeholder="如：初始上传" maxLength={500} showWordLimit /></Form.Item></Form></Modal>
}

function VersionUploadModal({ projectId, document, onClose, onSaved }: { projectId: string; document: KnowledgeDocument | null; onClose: () => void; onSaved: () => void }) {
  const [file, setFile] = useState<File>(); const [summary, setSummary] = useState(''); const [saving, setSaving] = useState(false)
  useEffect(() => { setFile(undefined); setSummary('') }, [document])
  if (!document) return null
  const submit = async () => { if (!file) return Message.warning('请选择新版本文件'); try { setSaving(true); await uploadKnowledgeDocumentVersion(projectId, document.id, { file, changeSummary: summary }); Message.success('新版本上传成功'); await onSaved() } catch (reason) { Message.error(reason instanceof ApiError ? reason.message : '新版本上传失败') } finally { setSaving(false) } }
  return <Modal title={`上传新版本：${document.name}`} visible onCancel={onClose} onOk={submit} confirmLoading={saving} autoFocus={false}><Space direction="vertical" style={{ width: '100%' }} size={16}><input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.zip,.png,.jpg,.jpeg" onChange={event => setFile(event.target.files?.[0])} />{file ? <Typography.Text type="secondary">{file.name} · {formatBytes(file.size)}</Typography.Text> : null}<Input.TextArea value={summary} onChange={setSummary} placeholder="填写本版本的变更说明" maxLength={500} showWordLimit /></Space></Modal>
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function flattenFolders(folders: KnowledgeFolder[]) { const result: KnowledgeFolder[] = []; const visit = (items: KnowledgeFolder[]) => { for (const item of items) { result.push(item); visit(item.children) } }; visit(folders); return result }
function collectDescendantIds(folder: KnowledgeFolder): string[] { return folder.children.flatMap(child => [child.id, ...collectDescendantIds(child)]) }
function hasFilters(query: string, folderId: string, status: string, fileType: string, includeArchived: boolean) { return Boolean(query || folderId !== 'all' || status !== 'all' || fileType || includeArchived) }
function formatBytes(value: number) { if (!value) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const level = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); const amount = value / 1024 ** level; return `${amount >= 10 || level === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[level]}` }
function formatDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
function fileLabel(value: string) { return value.replace(/^\./, '').slice(0, 4).toUpperCase() || 'FILE' }
function fileTone(value: string) { const type = value.toLowerCase(); if (type.includes('pdf')) return 'red'; if (type.includes('doc')) return 'blue'; if (type.includes('xls')) return 'green'; if (type.includes('ppt')) return 'orange'; return 'gray' }
function folderErrorMessage(reason: unknown, fallback: string) { if (!(reason instanceof ApiError)) return fallback; const labels: Record<string, string> = { knowledge_folder_duplicate: '同级目录中已存在该名称', knowledge_folder_not_empty: '目录包含子目录，无法删除', knowledge_folder_has_documents: '目录包含文档，无法删除', knowledge_folder_parent_cycle: '不能把目录移动到其子目录下', knowledge_folder_name_invalid: '目录名称不能包含斜杠、反斜杠或控制字符' }; return reason.code ? labels[reason.code] ?? reason.message : reason.message }

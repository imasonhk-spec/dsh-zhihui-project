import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client.ts'
import { auditLogs, documents, documentVersions, knowledgeBases, knowledgeFolders, projects } from '../../db/schema.ts'
import { buildKnowledgeObjectKey, checksumSha256, deleteKnowledgeObject, getKnowledgeObject, putKnowledgeObject } from '../../infrastructure/object-storage.ts'
import { authorizePortfolioKnowledge } from './knowledge-authorization.ts'

export const DEFAULT_KNOWLEDGE_FOLDERS = [
  '01-项目管理过程',
  '02-需求与设计',
  '03-开发与测试',
  '04-部署与运维',
  '05-最终交付物',
  '06-合同与商务',
  '07-前期筹备与变更',
  '08-知识传递与总结',
] as const
const PROJECT_MANAGEMENT_SUBFOLDERS = ['01-项目实施计划', '02-会议纪要', '03-周报与汇报', '04-市场拓展&解决方案周会待办事项汇总表', '05-项目交付中心周会待办事项汇总表'] as const

export type KnowledgeFolderInput = { parentId?: string | null; name: string; sortOrder?: number }
export type KnowledgeFolderUpdate = { parentId?: string | null; name?: string; sortOrder?: number }
export type KnowledgeDocumentFilters = { q?: string; folderId?: string; status?: string; fileType?: string; includeArchived?: string }
export type KnowledgeDocumentUpload = { fileName: string; mimeType?: string; body: Buffer; fields: { name?: string; folderId?: string; status?: string; changeSummary?: string } }
export type KnowledgeDocumentUpdate = { name?: string; folderId?: string | null; status?: string }
export type ProjectProcessDocumentKind = 'implementation-plan' | 'meeting-minutes' | 'weekly-report' | 'market-solution-meeting-todos' | 'delivery-meeting-todos' | 'government-enterprise-opportunity'

const folderInputKeys = new Set(['parentId', 'name', 'sortOrder'])
const documentUpdateKeys = new Set(['name', 'folderId', 'status'])
const documentStatuses = new Set(['draft', 'reviewing', 'confirmed', 'archived', 'obsolete'])
const MIME_BY_EXTENSION: Record<string, string> = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
const allowedExtensions = new Set(Object.keys(MIME_BY_EXTENSION))

export type KnowledgeFolderSourceBreakdown={code:string;name:string;count:number}
type KnowledgeFolderNode=typeof knowledgeFolders.$inferSelect&{documentCount:number;sourceBreakdown?:KnowledgeFolderSourceBreakdown[];children:KnowledgeFolderNode[]}
type AggregatedFolderSource={id:string;path:string;projectId:string;projectCode:string;projectName:string}
type AggregatedFolderDocument={projectId:string|null;folderId:string|null;status:string}
export function buildAggregatedFolderTree(folderSources:AggregatedFolderSource[],documents:AggregatedFolderDocument[],knowledgeBaseId:string){
  const folderByProjectAndId=new Map<string,string>()
  const projectById=new Map<string,{code:string;name:string}>()
  for(const folder of folderSources){projectById.set(folder.projectId,{code:folder.projectCode,name:folder.projectName});folderByProjectAndId.set(`${folder.projectId}:${folder.id}`,folder.path)}
  const countsByPathAndProject=new Map<string,Map<string,number>>()
  for(const document of documents){
    if(!document.projectId||!document.folderId||['archived','obsolete'].includes(document.status))continue
    const path=folderByProjectAndId.get(`${document.projectId}:${document.folderId}`)
    if(!path)continue
    const counts=countsByPathAndProject.get(path)??new Map<string,number>()
    counts.set(document.projectId,(counts.get(document.projectId)??0)+1)
    countsByPathAndProject.set(path,counts)
  }
  const paths=[...new Set(folderSources.map(folder=>folder.path))].sort((a,b)=>a.localeCompare(b,'zh-CN'))
  const nodes=new Map<string,KnowledgeFolderNode>()
  for(const path of paths){
    const parts=path.split('/'),name=parts.at(-1)!,counts=countsByPathAndProject.get(path)??new Map<string,number>()
    const sourceBreakdown=[...counts].map(([sourceProjectId,count])=>({...projectById.get(sourceProjectId)!,count})).sort((a,b)=>a.code.localeCompare(b.code,'zh-CN')||a.name.localeCompare(b.name,'zh-CN'))
    nodes.set(path,{id:`all:${path}`,knowledgeBaseId,parentId:parts.length>1?`all:${parts.slice(0,-1).join('/')}`:null,name,path,sortOrder:paths.indexOf(path),documentCount:sourceBreakdown.reduce((sum,item)=>sum+item.count,0),sourceBreakdown,createdAt:new Date(0),updatedAt:new Date(0),children:[]})
  }
  const roots:KnowledgeFolderNode[]=[]
  for(const [path,node]of nodes){const parentPath=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';const parent=parentPath?nodes.get(parentPath):undefined;if(parent)parent.children.push(node);else roots.push(node)}
  return roots
}
export async function getAllProjectsKnowledgeWorkspace(projectId:string){
  const authorization=await authorizePortfolioKnowledge(projectId)
  return buildAllProjectsKnowledgeWorkspace(projectId,authorization.authorizedProjectIds)
}

async function buildAllProjectsKnowledgeWorkspace(projectId:string,authorizedProjectIds:string[]){
  const authorized=sql`${documents.projectId} is not null and ${documents.projectId} in (${sql.join(authorizedProjectIds.map(id=>sql`${id}::uuid`),sql`, `)}) and ${knowledgeBases.scope}='project' and ${knowledgeBases.accountId} is null and ${knowledgeBases.projectId}=${documents.projectId}`
  const [allFolders,documentRows,recentRows]=await Promise.all([
    db.select({id:knowledgeFolders.id,path:knowledgeFolders.path,projectId:projects.id,projectCode:projects.code,projectName:projects.name}).from(knowledgeFolders).innerJoin(knowledgeBases,eq(knowledgeBases.id,knowledgeFolders.knowledgeBaseId)).innerJoin(projects,eq(projects.id,knowledgeBases.projectId)).where(and(eq(knowledgeBases.scope,'project'),isNull(knowledgeBases.accountId),inArray(knowledgeBases.projectId,authorizedProjectIds))).orderBy(asc(knowledgeFolders.sortOrder),asc(knowledgeFolders.name)),
    db.select({id:documents.id,projectId:documents.projectId,folderId:documents.folderId,status:documents.status,fileSize:documents.fileSize}).from(documents).innerJoin(knowledgeBases,eq(knowledgeBases.id,documents.knowledgeBaseId)).where(authorized),
    db.select({id:documents.id,projectId:documents.projectId,name:documents.name,fileType:documents.fileType,version:documents.version,status:documents.status,folderId:documents.folderId,folderPath:knowledgeFolders.path,fileSize:documents.fileSize,updatedAt:documents.updatedAt}).from(documents).innerJoin(knowledgeBases,eq(knowledgeBases.id,documents.knowledgeBaseId)).leftJoin(knowledgeFolders,eq(knowledgeFolders.id,documents.folderId)).where(and(authorized,sql`${documents.status} not in ('archived','obsolete')`)).orderBy(desc(documents.updatedAt),desc(documents.id)), 
  ])
  const own=await ensureProjectKnowledgeWorkspace(projectId)
  const activeDocuments=documentRows.filter(document=>!['archived','obsolete'].includes(document.status))
  const roots=buildAggregatedFolderTree(allFolders,documentRows,own.id)
  return{knowledgeBase:{...own,name:'所有项目知识库'},folders:roots,summary:{folders:new Set(allFolders.map(folder=>folder.path)).size,documents:documentRows.length,activeDocuments:activeDocuments.length,archivedDocuments:documentRows.filter(x=>x.status==='archived').length,storageBytes:documentRows.reduce((s,x)=>s+(x.fileSize??0),0)},recentDocuments:recentRows}
}

export async function getProjectKnowledgeWorkspace(projectId: string) {
  assertUuid(projectId, 'project_id_invalid')
  const workspace = await ensureProjectKnowledgeWorkspace(projectId)
  const [folders, documentRows, recentRows] = await Promise.all([
    db.select().from(knowledgeFolders).where(eq(knowledgeFolders.knowledgeBaseId, workspace.id)).orderBy(asc(knowledgeFolders.sortOrder), asc(knowledgeFolders.name)),
    db.select({ id: documents.id, folderId: documents.folderId, status: documents.status, fileSize: documents.fileSize }).from(documents).where(and(eq(documents.projectId, projectId), eq(documents.knowledgeBaseId, workspace.id))),
    db.select({ id: documents.id, name: documents.name, fileType: documents.fileType, version: documents.version, status: documents.status, folderId: documents.folderId, folderPath: knowledgeFolders.path, fileSize: documents.fileSize, updatedAt: documents.updatedAt }).from(documents).leftJoin(knowledgeFolders, eq(knowledgeFolders.id, documents.folderId)).where(and(eq(documents.projectId, projectId), eq(documents.knowledgeBaseId, workspace.id), sql`${documents.status} not in ('archived', 'obsolete')`)).orderBy(desc(documents.updatedAt), desc(documents.id)).limit(5),
  ])
  const counts = new Map<string, number>()
  for (const document of documentRows) if (document.folderId) counts.set(document.folderId, (counts.get(document.folderId) ?? 0) + 1)
  return {
    knowledgeBase: workspace,
    folders: toFolderTree(folders.map(folder => ({ ...folder, documentCount: counts.get(folder.id) ?? 0 }))),
    summary: {
      folders: folders.length,
      documents: documentRows.length,
      activeDocuments: documentRows.filter(document => document.status !== 'archived' && document.status !== 'obsolete').length,
      archivedDocuments: documentRows.filter(document => document.status === 'archived').length,
      storageBytes: documentRows.reduce((total, document) => total + (document.fileSize ?? 0), 0),
    },
    recentDocuments: recentRows,
  }
}

export async function listProjectKnowledgeFolders(projectId: string) {
  assertUuid(projectId, 'project_id_invalid')
  const workspace = await ensureProjectKnowledgeWorkspace(projectId)
  const rows = await db.select().from(knowledgeFolders).where(eq(knowledgeFolders.knowledgeBaseId, workspace.id)).orderBy(asc(knowledgeFolders.sortOrder), asc(knowledgeFolders.name))
  return toFolderTree(rows)
}

export async function createProjectKnowledgeFolder(projectId: string, input: KnowledgeFolderInput) {
  assertUuid(projectId, 'project_id_invalid')
  validateFolderInput(input)
  const workspace = await ensureProjectKnowledgeWorkspace(projectId)
  const parent = input.parentId ? await getFolder(workspace.id, input.parentId) : undefined
  if (input.parentId && !parent) throw new Error('knowledge_parent_folder_not_found')
  const name = normalizeFolderName(input.name)
  const path = parent ? `${parent.path}/${name}` : name
  return db.transaction(async tx => {
    const [row] = await tx.insert(knowledgeFolders).values({ knowledgeBaseId: workspace.id, parentId: parent?.id ?? null, name, path, sortOrder: input.sortOrder ?? 0 }).returning()
    await tx.insert(auditLogs).values({ projectId, entityType: 'folder', entityId: row.id, action: 'created', actorName: 'system', changes: { name: row.name, summary: `新增知识库目录 ${row.path}` } })
    return row
  })
}

export async function updateProjectKnowledgeFolder(projectId: string, folderId: string, input: KnowledgeFolderUpdate) {
  assertUuid(projectId, 'project_id_invalid'); assertUuid(folderId, 'knowledge_folder_id_invalid')
  validateFolderInput(input, true)
  const workspace = await ensureProjectKnowledgeWorkspace(projectId)
  const existing = await getFolder(workspace.id, folderId)
  if (!existing) return undefined
  if (!Object.keys(input).length) return existing
  const allFolders = await db.select().from(knowledgeFolders).where(eq(knowledgeFolders.knowledgeBaseId, workspace.id))
  const nextParentId = input.parentId === undefined ? existing.parentId : input.parentId
  if (nextParentId === folderId) throw new Error('knowledge_folder_parent_self')
  const descendants = collectDescendantIds(allFolders, folderId)
  if (nextParentId && descendants.has(nextParentId)) throw new Error('knowledge_folder_parent_cycle')
  const parent = nextParentId ? allFolders.find(folder => folder.id === nextParentId) : undefined
  if (nextParentId && !parent) throw new Error('knowledge_parent_folder_not_found')
  const name = input.name === undefined ? existing.name : normalizeFolderName(input.name)
  const nextPath = parent ? `${parent.path}/${name}` : name
  const changed = name !== existing.name || nextParentId !== existing.parentId || (input.sortOrder !== undefined && input.sortOrder !== existing.sortOrder)
  if (!changed) return existing
  const oldPrefix = `${existing.path}/`
  return db.transaction(async tx => {
    const [row] = await tx.update(knowledgeFolders).set({ name, parentId: nextParentId ?? null, path: nextPath, sortOrder: input.sortOrder ?? existing.sortOrder, updatedAt: new Date() }).where(and(eq(knowledgeFolders.id, folderId), eq(knowledgeFolders.knowledgeBaseId, workspace.id))).returning()
    const children = allFolders.filter(folder => descendants.has(folder.id))
    for (const child of children) {
      const childPath = `${nextPath}/${child.path.slice(oldPrefix.length)}`
      await tx.update(knowledgeFolders).set({ path: childPath, updatedAt: new Date() }).where(eq(knowledgeFolders.id, child.id))
    }
    await tx.insert(auditLogs).values({ projectId, entityType: 'folder', entityId: row.id, action: 'updated', actorName: 'system', changes: { name: row.name, path: { from: existing.path, to: row.path }, summary: `更新知识库目录 ${existing.path} → ${row.path}` } })
    return row
  })
}

export async function deleteProjectKnowledgeFolder(projectId: string, folderId: string) {
  assertUuid(projectId, 'project_id_invalid'); assertUuid(folderId, 'knowledge_folder_id_invalid')
  const workspace = await ensureProjectKnowledgeWorkspace(projectId)
  const existing = await getFolder(workspace.id, folderId)
  if (!existing) return false
  const [child] = await db.select({ id: knowledgeFolders.id }).from(knowledgeFolders).where(and(eq(knowledgeFolders.knowledgeBaseId, workspace.id), eq(knowledgeFolders.parentId, folderId))).limit(1)
  if (child) throw new Error('knowledge_folder_not_empty')
  const [document] = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.knowledgeBaseId, workspace.id), eq(documents.folderId, folderId))).limit(1)
  if (document) throw new Error('knowledge_folder_has_documents')
  await db.transaction(async tx => {
    await tx.delete(knowledgeFolders).where(and(eq(knowledgeFolders.id, folderId), eq(knowledgeFolders.knowledgeBaseId, workspace.id)))
    await tx.insert(auditLogs).values({ projectId, entityType: 'folder', entityId: folderId, action: 'deleted', actorName: 'system', changes: { name: existing.name, summary: `删除知识库目录 ${existing.path}` } })
  })
  return true
}

export async function listProjectKnowledgeDocuments(projectId: string, filters: KnowledgeDocumentFilters = {}) {
  assertUuid(projectId, 'project_id_invalid')
  validateDocumentFilters(filters)
  const workspace = await ensureProjectKnowledgeWorkspace(projectId)
  if (filters.folderId && !(await getFolder(workspace.id, filters.folderId))) throw new Error('knowledge_folder_not_found')
  const rows = await db.select().from(documents).where(and(eq(documents.projectId, projectId), eq(documents.knowledgeBaseId, workspace.id))).orderBy(asc(documents.name))
  const query = filters.q?.trim().toLowerCase()
  return rows.filter(document => {
    if (filters.includeArchived !== 'true' && (document.status === 'archived' || document.status === 'obsolete')) return false
    if (filters.folderId && document.folderId !== filters.folderId) return false
    if (filters.status && document.status !== filters.status) return false
    if (filters.fileType && document.fileType.toLowerCase() !== filters.fileType.trim().toLowerCase()) return false
    if (query && ![document.name, document.originalName, document.fileType].some(value => value.toLowerCase().includes(query))) return false
    return true
  })
}

export async function getProjectKnowledgeDocument(projectId: string, documentId: string) {
  assertUuid(projectId, 'project_id_invalid'); assertUuid(documentId, 'knowledge_document_id_invalid')
  const workspace = await ensureProjectKnowledgeWorkspace(projectId)
  const [row] = await db.select().from(documents).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId), eq(documents.knowledgeBaseId, workspace.id))).limit(1)
  return row
}

export function isAppendOnlyProjectProcessDocumentKind(kind: ProjectProcessDocumentKind) { return kind === 'market-solution-meeting-todos' || kind === 'delivery-meeting-todos' }

export async function createProjectProcessDocument(projectId: string, kind: ProjectProcessDocumentKind, upload: KnowledgeDocumentUpload) {
  const folderName = ({ 'implementation-plan': '01-项目实施计划', 'meeting-minutes': '02-会议纪要', 'weekly-report': '03-周报与汇报', 'market-solution-meeting-todos': '04-市场拓展&解决方案周会待办事项汇总表', 'delivery-meeting-todos': '05-项目交付中心周会待办事项汇总表', 'government-enterprise-opportunity': '06-合同与商务' } as const)[kind]
  if (!folderName) throw new Error('project_process_document_kind_invalid')
  const workspace = await ensureProjectKnowledgeWorkspace(projectId)
  const folders = await db.select().from(knowledgeFolders).where(eq(knowledgeFolders.knowledgeBaseId, workspace.id))
  const folder = folders.find(item => item.path === `01-项目管理过程/${folderName}`) ?? folders.find(item => item.path === folderName)
  if (!folder) throw new Error('knowledge_folder_not_found')
  const checksum = checksumSha256(upload.body)
  const appendOnly = isAppendOnlyProjectProcessDocumentKind(kind)
  if (!appendOnly) {
    const [existing] = await db.select().from(documents).where(and(eq(documents.projectId, projectId), eq(documents.knowledgeBaseId, workspace.id), eq(documents.folderId, folder.id), eq(documents.checksum, checksum))).limit(1)
    if (existing) return existing
  }
  const created = await createProjectKnowledgeDocument(projectId, { ...upload, fields: { ...upload.fields, folderId: folder.id, status: upload.fields.status || 'confirmed' } })
  if (appendOnly) {
    await db.update(documents).set({ status: 'archived', updatedAt: new Date(), metadata: sql`coalesce(${documents.metadata}, '{}'::jsonb) || '{"supersededByNewerImport":true}'::jsonb` }).where(and(eq(documents.projectId, projectId), eq(documents.knowledgeBaseId, workspace.id), eq(documents.folderId, folder.id), sql`${documents.id} <> ${created.id}`, sql`${documents.status} not in ('archived','obsolete')`))
  }
  return created
}

export async function createProjectKnowledgeDocument(projectId: string, upload: KnowledgeDocumentUpload) {
  const workspace = await ensureProjectKnowledgeWorkspace(projectId)
  const file = validateUpload(upload)
  const folderId = upload.fields.folderId || null
  if (folderId && !(await getFolder(workspace.id, folderId))) throw new Error('knowledge_folder_not_found')
  const status = upload.fields.status || 'draft'
  if (!documentStatuses.has(status)) throw new Error('knowledge_document_status_invalid')
  const documentId = randomUUID(), versionId = randomUUID(), version = 'v1'
  const key = buildKnowledgeObjectKey(projectId, documentId, versionId)
  const checksum = checksumSha256(upload.body)
  await putKnowledgeObject({ key, body: upload.body, contentType: file.mimeType, contentLength: upload.body.length })
  try {
    return await db.transaction(async tx => {
      const [document] = await tx.insert(documents).values({ id: documentId, projectId, knowledgeBaseId: workspace.id, folderId, name: normalizeDocumentName(upload.fields.name || file.displayName), originalName: file.originalName, fileType: file.extension, mimeType: file.mimeType, fileSize: upload.body.length, checksum, storageKey: key, version, status: status as never, aiEnabled: false }).returning()
      await tx.insert(documentVersions).values({ id: versionId, documentId, versionNumber: version, storageKey: key, checksum, fileSize: upload.body.length, mimeType: file.mimeType, originalName: file.originalName, changeSummary: normalizeOptionalText(upload.fields.changeSummary, 500) || '初始版本', isCurrent: true })
      await tx.insert(auditLogs).values({ projectId, entityType: 'document', entityId: documentId, action: 'created', actorName: 'system', changes: { name: document.name, version, summary: `上传文档 ${document.name}（${version}）` } })
      return document
    })
  } catch (error) { await deleteKnowledgeObject(key).catch(() => undefined); throw error }
}

export async function updateProjectKnowledgeDocument(projectId: string, documentId: string, input: KnowledgeDocumentUpdate) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('knowledge_document_body_invalid')
  for (const key of Object.keys(input)) if (!documentUpdateKeys.has(key)) throw new Error('knowledge_document_field_invalid')
  const existing = await getProjectKnowledgeDocument(projectId, documentId)
  if (!existing) return undefined
  if (input.name !== undefined) normalizeDocumentName(input.name)
  if (input.folderId !== undefined && input.folderId !== null) { assertUuid(input.folderId, 'knowledge_folder_id_invalid'); if (!(await getFolder(existing.knowledgeBaseId, input.folderId))) throw new Error('knowledge_folder_not_found') }
  if (input.status !== undefined && !documentStatuses.has(input.status)) throw new Error('knowledge_document_status_invalid')
  const nextStatus = (input.status ?? existing.status) as typeof existing.status
  const statusTransition = nextStatus !== existing.status
  const nextMetadata = statusTransition ? { ...existing.metadata } : existing.metadata
  if (nextStatus === 'archived' && existing.status !== 'archived') nextMetadata.statusBeforeArchive = existing.status
  if (existing.status === 'archived' && nextStatus !== 'archived') delete nextMetadata.statusBeforeArchive
  const desired = { name: input.name === undefined ? existing.name : normalizeDocumentName(input.name), folderId: input.folderId === undefined ? existing.folderId : input.folderId, status: nextStatus, metadata: nextMetadata }
  const changes: Record<string, unknown> = {}
  for (const key of ['name', 'folderId', 'status'] as const) if (desired[key] !== existing[key]) changes[key] = { from: existing[key], to: desired[key] }
  if (!Object.keys(changes).length) return existing
  return db.transaction(async tx => {
    const [row] = await tx.update(documents).set({ ...desired, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId))).returning()
    const action = desired.status !== existing.status && desired.status === 'archived' ? 'archived' : 'updated'
    await tx.insert(auditLogs).values({ projectId, entityType: 'document', entityId: documentId, action, actorName: 'system', changes: { ...changes, name: row.name, summary: `${action === 'archived' ? '归档' : desired.status !== existing.status && existing.status === 'archived' ? '恢复' : '更新'}文档 ${row.name}` } })
    return row
  })
}

export async function listProjectKnowledgeDocumentVersions(projectId: string, documentId: string) {
  const document = await getProjectKnowledgeDocument(projectId, documentId)
  if (!document) return undefined
  return db.select().from(documentVersions).where(eq(documentVersions.documentId, documentId)).orderBy(desc(documentVersions.createdAt))
}

export async function createProjectKnowledgeDocumentVersion(projectId: string, documentId: string, upload: KnowledgeDocumentUpload) {
  const document = await getProjectKnowledgeDocument(projectId, documentId)
  if (!document) return undefined
  const file = validateUpload(upload)
  const versionId = randomUUID()
  const key = buildKnowledgeObjectKey(projectId, documentId, versionId)
  const checksum = checksumSha256(upload.body)
  await putKnowledgeObject({ key, body: upload.body, contentType: file.mimeType, contentLength: upload.body.length })
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`select ${documents.id} from ${documents} where ${documents.id} = ${documentId} for update`)
      const versions = await tx.select({ versionNumber: documentVersions.versionNumber }).from(documentVersions).where(eq(documentVersions.documentId, documentId))
      const nextNumber = Math.max(0, ...versions.map(item => Number.parseInt(item.versionNumber.replace(/^v/, ''), 10) || 0)) + 1
      const version = `v${nextNumber}`
      await tx.update(documentVersions).set({ isCurrent: false, updatedAt: new Date() }).where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.isCurrent, true)))
      const [versionRow] = await tx.insert(documentVersions).values({ id: versionId, documentId, versionNumber: version, storageKey: key, checksum, fileSize: upload.body.length, mimeType: file.mimeType, originalName: file.originalName, changeSummary: normalizeOptionalText(upload.fields.changeSummary, 500), isCurrent: true }).returning()
      await tx.update(documents).set({ originalName: file.originalName, fileType: file.extension, mimeType: file.mimeType, fileSize: upload.body.length, checksum, storageKey: key, version, parseStatus: 'pending', indexStatus: 'pending', aiEnabled: false, updatedAt: new Date() }).where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
      await tx.insert(auditLogs).values({ projectId, entityType: 'document', entityId: documentId, action: 'updated', actorName: 'system', changes: { name: document.name, version: { from: document.version, to: version }, summary: `上传文档新版本 ${document.name}（${version}）` } })
      return versionRow
    })
  } catch (error) { await deleteKnowledgeObject(key).catch(() => undefined); throw error }
}

export async function getProjectKnowledgeDocumentDownload(projectId: string, documentId: string, versionId?: string) {
  const document = await getProjectKnowledgeDocument(projectId, documentId)
  if (!document) return undefined
  let storageKey = document.storageKey, originalName = document.originalName, mimeType = document.mimeType, fileSize = document.fileSize
  if (versionId) {
    assertUuid(versionId, 'knowledge_version_id_invalid')
    const [version] = await db.select().from(documentVersions).where(and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, documentId))).limit(1)
    if (!version) throw new Error('knowledge_version_not_found')
    storageKey = version.storageKey; originalName = version.originalName || `document-${version.versionNumber}`; mimeType = version.mimeType || 'application/octet-stream'; fileSize = version.fileSize
  }
  if (!storageKey) throw new Error('knowledge_document_file_missing')
  return { object: await getKnowledgeObject(storageKey), fileName: originalName, mimeType: mimeType || 'application/octet-stream', fileSize }
}

export async function ensureProjectKnowledgeWorkspace(projectId: string) {
  assertUuid(projectId, 'project_id_invalid')
  const [project] = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!project) throw new Error('project_not_found')
  const [existing] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.projectId, projectId)).orderBy(asc(knowledgeBases.createdAt)).limit(1)
  if (existing) { await ensureProjectManagementSubfolders(existing.id); return existing }
  const workspace = await db.transaction(async tx => {
    const [concurrent] = await tx.select().from(knowledgeBases).where(eq(knowledgeBases.projectId, projectId)).orderBy(asc(knowledgeBases.createdAt)).limit(1)
    if (concurrent) return concurrent
    const [created] = await tx.insert(knowledgeBases).values({ projectId, name: `${project.name}项目知识库`, description: '项目档案、过程资料、交付物和结构化项目数据的统一知识库。', scope: 'project' }).returning()
    const roots = await tx.insert(knowledgeFolders).values(DEFAULT_KNOWLEDGE_FOLDERS.map((name, index) => ({ knowledgeBaseId: created.id, name, path: name, sortOrder: index + 1 }))).returning()
    const management = roots.find(folder => folder.name === '01-项目管理过程')
    if (management) await tx.insert(knowledgeFolders).values(PROJECT_MANAGEMENT_SUBFOLDERS.map((name, index) => ({ knowledgeBaseId: created.id, parentId: management.id, name, path: `${management.path}/${name}`, sortOrder: index + 1 })))
    return created
  })
  await ensureProjectManagementSubfolders(workspace.id)
  return workspace
}

async function ensureProjectManagementSubfolders(knowledgeBaseId: string) {
  const folders = await db.select().from(knowledgeFolders).where(eq(knowledgeFolders.knowledgeBaseId, knowledgeBaseId))
  const management = folders.find(folder => folder.path === '01-项目管理过程')
  if (!management) return
  const missing = PROJECT_MANAGEMENT_SUBFOLDERS.filter(name => !folders.some(folder => folder.path === `${management.path}/${name}`))
  if (missing.length) await db.insert(knowledgeFolders).values(missing.map(name => ({ knowledgeBaseId, parentId: management.id, name, path: `${management.path}/${name}`, sortOrder: PROJECT_MANAGEMENT_SUBFOLDERS.indexOf(name) + 1 }))).onConflictDoNothing()
  for (const [index, name] of PROJECT_MANAGEMENT_SUBFOLDERS.entries()) {
    const folder = folders.find(item => item.path === `${management.path}/${name}`)
    if (folder && folder.sortOrder !== index + 1) await db.update(knowledgeFolders).set({ sortOrder: index + 1, updatedAt: new Date() }).where(eq(knowledgeFolders.id, folder.id))
  }
}

function validateFolderInput(input: Partial<KnowledgeFolderInput>, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('knowledge_folder_body_invalid')
  for (const key of Object.keys(input)) if (!folderInputKeys.has(key)) throw new Error('knowledge_folder_field_invalid')
  if (!partial && (typeof input.name !== 'string' || !input.name.trim())) throw new Error('knowledge_folder_name_required')
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new Error('knowledge_folder_name_invalid')
  if (input.parentId !== undefined && input.parentId !== null && (typeof input.parentId !== 'string' || !UUID_PATTERN.test(input.parentId))) throw new Error('knowledge_folder_parent_invalid')
  if (input.sortOrder !== undefined && (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0)) throw new Error('knowledge_folder_sort_order_invalid')
}
function validateUpload(upload: KnowledgeDocumentUpload) {
  if (!upload.body.length) throw new Error('knowledge_file_empty')
  const originalName = sanitizeFileName(upload.fileName)
  const extension = originalName.includes('.') ? originalName.split('.').pop()!.toLowerCase() : ''
  if (!allowedExtensions.has(extension)) throw new Error('knowledge_file_type_unsupported')
  if (upload.fields.folderId) assertUuid(upload.fields.folderId, 'knowledge_folder_id_invalid')
  const mimeType = MIME_BY_EXTENSION[extension] || 'application/octet-stream'
  return { originalName, displayName: originalName.replace(/\.[^.]+$/, ''), extension, mimeType }
}
function sanitizeFileName(value: string) {
  const name = value.replace(/[\r\n]/g, '').split(/[\\/]/).pop()?.trim() || ''
  if (!name || name === '.' || name === '..' || name.length > 240) throw new Error('knowledge_file_name_invalid')
  return name
}
function normalizeDocumentName(value: string) { const name = value.trim(); if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) throw new Error('knowledge_document_name_invalid'); return name }
function normalizeOptionalText(value: string | undefined, max: number) { const text = value?.trim() || ''; if (text.length > max) throw new Error('knowledge_text_too_long'); return text || null }
function validateDocumentFilters(filters: KnowledgeDocumentFilters) {
  if (filters.q && filters.q.trim().length > 200) throw new Error('knowledge_query_too_long')
  if (filters.folderId && !UUID_PATTERN.test(filters.folderId)) throw new Error('knowledge_folder_id_invalid')
  if (filters.fileType && (!/^[a-zA-Z0-9._+-]{1,32}$/.test(filters.fileType.trim()))) throw new Error('knowledge_file_type_invalid')
  if (filters.status && !documentStatuses.has(filters.status)) throw new Error('knowledge_document_status_invalid')
  if (filters.includeArchived && !['true', 'false'].includes(filters.includeArchived)) throw new Error('knowledge_include_archived_invalid')
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function assertUuid(value: string, code: string) { if (!UUID_PATTERN.test(value)) throw new Error(code) }
function normalizeFolderName(value: string) {
  const name = value.trim()
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || /[\u0000-\u001f]/.test(name)) throw new Error('knowledge_folder_name_invalid')
  if (name.length > 120) throw new Error('knowledge_folder_name_too_long')
  return name
}
async function getFolder(knowledgeBaseId: string, folderId: string) {
  const [row] = await db.select().from(knowledgeFolders).where(and(eq(knowledgeFolders.id, folderId), eq(knowledgeFolders.knowledgeBaseId, knowledgeBaseId))).limit(1)
  return row
}
function collectDescendantIds(rows: Array<typeof knowledgeFolders.$inferSelect>, rootId: string) {
  const result = new Set<string>()
  let frontier = [rootId]
  while (frontier.length) {
    const children = rows.filter(row => row.parentId && frontier.includes(row.parentId)).map(row => row.id)
    for (const child of children) result.add(child)
    frontier = children
  }
  return result
}
function toFolderTree<T extends typeof knowledgeFolders.$inferSelect & Record<string, unknown>>(rows: T[]) {
  type Node = T & { children: Node[] }
  const nodes = new Map(rows.map(row => [row.id, { ...row, children: [] } as Node]))
  const roots: Node[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (items: Node[]) => { items.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)); for (const item of items) sort(item.children) }
  sort(roots)
  return roots
}

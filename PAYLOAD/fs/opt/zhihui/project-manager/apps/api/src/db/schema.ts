import { boolean, customType, date, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid, vector } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })
const id = () => uuid('id').defaultRandom().primaryKey()
const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}

export const projectStatus = pgEnum('project_status', ['planning', 'in_progress', 'on_hold', 'completed', 'archived'])
export const taskStatus = pgEnum('task_status', ['not_started', 'ready', 'in_progress', 'delayed', 'completed', 'closed', 'cancelled', 'blocked'])
export const priority = pgEnum('priority', ['low', 'medium', 'high', 'critical'])
export const milestoneStatus = pgEnum('milestone_status', ['not_started', 'in_progress', 'delayed', 'completed', 'cancelled'])
export const riskLevel = pgEnum('risk_level', ['low', 'medium', 'high', 'critical'])
export const riskStatus = pgEnum('risk_status', ['identified', 'following', 'mitigated', 'closed', 'accepted'])
export const coordinationStatus = pgEnum('coordination_status', ['to_start', 'communicating', 'resolved', 'closed'])
export const documentStatus = pgEnum('document_status', ['draft', 'reviewing', 'confirmed', 'archived', 'obsolete'])
export const processingStatus = pgEnum('processing_status', ['pending', 'processing', 'completed', 'failed'])
export const aiConversationStatus = pgEnum('ai_conversation_status', ['active', 'archived'])
export const personalReportPeriod = pgEnum('personal_report_period', ['daily', 'weekly', 'monthly'])
export const personalReportStatus = pgEnum('personal_report_status', ['draft', 'completed', 'failed'])
export const aiMessageRole = pgEnum('ai_message_role', ['system', 'user', 'assistant', 'tool'])
export const aiMessageStatus = pgEnum('ai_message_status', ['pending', 'processing', 'completed', 'failed', 'cancelled'])

export const projects = pgTable('projects', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  shortName: text('short_name'),
  category: text('category'),
  status: projectStatus('status').notNull().default('planning'),
  health: text('health').notNull().default('healthy'),
  description: text('description'),
  clientName: text('client_name'),
  startDate: date('start_date'),
  plannedEndDate: date('planned_end_date'),
  actualEndDate: date('actual_end_date'),
  progress: real('progress').notNull().default(0),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
})

export const importJobs = pgTable('import_jobs', {
  id: id(), projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }), kind: text('kind').notNull(), sourceName: text('source_name').notNull(), status: processingStatus('status').notNull().default('pending'), totalRows: integer('total_rows').default(0), successRows: integer('success_rows').default(0), failedRows: integer('failed_rows').default(0), errors: jsonb('errors').$type<Array<{ row?: number; message: string }>>().notNull().default([]), ...timestamps,
})

/** ICT-1 append-only import ledger. Business rows are changed only when a preview batch is confirmed. */
export const importBatches = pgTable('import_batches', {
  id: id(), app: text('app').notNull(), scopeType: text('scope_type').notNull(), scopeId: uuid('scope_id').notNull(), kind: text('kind').notNull(), mode: text('mode').notNull().default('snapshot'),
  sourceName: text('source_name').notNull(), sourceChecksum: text('source_checksum').notNull(), mappingVersion: text('mapping_version').notNull().default('ICT-1'), normalizationVersion: text('normalization_version').notNull().default('ICT-1'),
  baseBatchId: uuid('base_batch_id'), previewFingerprint: text('preview_fingerprint').notNull(), status: text('status').notNull().default('previewed'), counts: jsonb('counts_json').$type<Record<string, unknown>>().notNull().default({}),
  actorId: text('actor_id'), actorName: text('actor_name'), requestId: text('request_id'), rollbackOfBatchId: uuid('rollback_of_batch_id'), appliedAt: timestamp('applied_at', { withTimezone: true }), ...timestamps,
}, table => [
  index('import_batches_scope_kind_created_idx').on(table.scopeId, table.kind, table.createdAt),
  uniqueIndex('import_batches_success_idempotency_uidx').on(table.app, table.scopeId, table.kind, table.sourceChecksum, table.baseBatchId, table.mappingVersion).where(sql`${table.status} = 'succeeded'`),
])
export const importBatchEntities = pgTable('import_batch_entities', {
  id: id(), batchId: uuid('batch_id').notNull().references(() => importBatches.id), entityType: text('entity_type').notNull(), businessKey: text('business_key').notNull(), targetEntityId: uuid('target_entity_id'), sourceSheet: text('source_sheet'), sourceRow: integer('source_row'), raw: jsonb('raw_json').$type<Record<string, unknown>>().notNull().default({}), normalized: jsonb('normalized_json').$type<Record<string, unknown>>().notNull().default({}), rowHash: text('row_hash').notNull(), changeType: text('change_type').notNull(), maxSeverity: text('max_severity').notNull().default('info'), changedFieldCount: integer('changed_field_count').notNull().default(0), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex('import_batch_entities_batch_key_uidx').on(table.batchId, table.entityType, table.businessKey), index('import_batch_entities_target_created_idx').on(table.targetEntityId, table.createdAt)])
export const importFieldChanges = pgTable('import_field_changes', {
  id: id(), batchId: uuid('batch_id').notNull().references(() => importBatches.id), batchEntityId: uuid('batch_entity_id').notNull().references(() => importBatchEntities.id), entityType: text('entity_type').notNull(), businessKey: text('business_key').notNull(), targetEntityId: uuid('target_entity_id'), fieldKey: text('field_key').notNull(), changeType: text('change_type').notNull(), direction: text('direction').notNull(), severity: text('severity').notNull(), oldValue: jsonb('old_value_json').$type<unknown>(), newValue: jsonb('new_value_json').$type<unknown>(), oldDisplay: text('old_display'), newDisplay: text('new_display'), derived: boolean('derived').notNull().default(false), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex('import_field_changes_batch_key_field_uidx').on(table.batchId, table.entityType, table.businessKey, table.fieldKey), index('import_field_changes_batch_severity_idx').on(table.batchId, table.severity), index('import_field_changes_target_created_idx').on(table.targetEntityId, table.createdAt)])

export const projectPhases = pgTable('project_phases', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), code: text('code').notNull(), sortOrder: integer('sort_order').notNull().default(0),
  status: taskStatus('status').notNull().default('not_started'), progress: real('progress').notNull().default(0),
  plannedStartDate: date('planned_start_date'), plannedEndDate: date('planned_end_date'),
  isCurrent: boolean('is_current').notNull().default(true), snapshotId: uuid('snapshot_id').references(() => importJobs.id, { onDelete: 'set null' }), archivedAt: timestamp('archived_at', { withTimezone: true }), ...timestamps,
}, table => [uniqueIndex('project_phases_project_code_uidx').on(table.projectId, table.code), index('project_phases_project_current_idx').on(table.projectId, table.isCurrent), index('project_phases_snapshot_idx').on(table.snapshotId)])

export const tasks = pgTable('tasks', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  phaseId: uuid('phase_id').references(() => projectPhases.id, { onDelete: 'set null' }),
  parentId: uuid('parent_id'), wbsCode: text('wbs_code').notNull(), name: text('name').notNull(), description: text('description'),
  vendor: text('vendor'), ownerName: text('owner_name'), status: taskStatus('status').notNull().default('not_started'),
  priority: priority('priority').notNull().default('medium'), progress: real('progress').notNull().default(0),
  plannedStartDate: date('planned_start_date'), plannedEndDate: date('planned_end_date'), actualStartDate: date('actual_start_date'), actualEndDate: date('actual_end_date'),
  deliverable: text('deliverable'), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  isCurrent: boolean('is_current').notNull().default(true), snapshotId: uuid('snapshot_id').references(() => importJobs.id, { onDelete: 'set null' }), archivedAt: timestamp('archived_at', { withTimezone: true }), ...timestamps,
}, table => [uniqueIndex('tasks_project_current_wbs_uidx').on(table.projectId, table.wbsCode).where(sql`${table.isCurrent} = true`), index('tasks_project_current_idx').on(table.projectId, table.isCurrent), index('tasks_snapshot_idx').on(table.snapshotId)])

export const taskDependencies = pgTable('task_dependencies', {
  id: id(), predecessorId: uuid('predecessor_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }), successorId: uuid('successor_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }), type: text('type').notNull().default('finish_to_start'), ...timestamps,
})

export const milestones = pgTable('milestones', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }), name: text('name').notNull(), description: text('description'),
  type: text('type').notNull().default('important'), status: milestoneStatus('status').notNull().default('not_started'), ownerName: text('owner_name'),
  plannedDate: date('planned_date').notNull(), actualDate: date('actual_date'), deliverable: text('deliverable'), ...timestamps,
}, table => [uniqueIndex('milestones_project_name_date_uidx').on(table.projectId, table.name, table.plannedDate)])

export const risks = pgTable('risks', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }), code: text('code').notNull(), name: text('name').notNull(), description: text('description'), impact: text('impact'), mitigation: text('mitigation'),
  level: riskLevel('level').notNull().default('medium'), status: riskStatus('status').notNull().default('identified'), ownerName: text('owner_name'), source: text('source'), expectedResolutionDate: date('expected_resolution_date'), closedAt: date('closed_at'), ...timestamps,
}, table => [uniqueIndex('risks_project_code_uidx').on(table.projectId, table.code)])

export const coordinationItems = pgTable('coordination_items', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }), code: text('code').notNull(), category: text('category').notNull(), title: text('title').notNull(), description: text('description'), counterparty: text('counterparty'), ownerName: text('owner_name'), priority: priority('priority').notNull().default('medium'), status: coordinationStatus('status').notNull().default('to_start'), progress: real('progress').notNull().default(0), dueDate: date('due_date'), resolvedAt: date('resolved_at'), ...timestamps,
}, table => [uniqueIndex('coordination_project_code_uidx').on(table.projectId, table.code)])

export const approvalItems = pgTable('approval_items', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }), stageCode: text('stage_code').notNull(), stageName: text('stage_name').notNull(), taskName: text('task_name').notNull(), deliverable: text('deliverable'), responsibleParty: text('responsible_party'), status: taskStatus('status').notNull().default('not_started'), plannedStartDate: date('planned_start_date'), plannedEndDate: date('planned_end_date'), actualStartDate: date('actual_start_date'), actualEndDate: date('actual_end_date'), result: text('result'), remark: text('remark'), sortOrder: integer('sort_order').notNull().default(0), ...timestamps,
}, table => [uniqueIndex('approval_project_stage_task_uidx').on(table.projectId, table.stageCode, table.taskName)])

export const deliveryMeetingTodoImports = pgTable('delivery_meeting_todo_imports', {
  id: id(), sourceName: text('source_name').notNull(), checksum: text('checksum').notNull(), totalRows: integer('total_rows').notNull().default(0), matchedRows: integer('matched_rows').notNull().default(0), unmatchedRows: integer('unmatched_rows').notNull().default(0), importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(), ...timestamps,
})
export const deliveryMeetingTodos = pgTable('delivery_meeting_todos', {
  id: id(), importId: uuid('import_id').notNull().references(() => deliveryMeetingTodoImports.id, { onDelete: 'cascade' }), projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }), sourceRow: integer('source_row').notNull(), sequence: integer('sequence'), establishedDate: date('established_date'), title: text('title').notNull(), ownerName: text('owner_name'), deadlineText: text('deadline_text'), dueDate: date('due_date'), projectNameRaw: text('project_name_raw'), status: text('status').notNull().default('pending'), resultRemark: text('result_remark'), ...timestamps,
}, table => [uniqueIndex('delivery_meeting_todos_import_row_uidx').on(table.importId, table.sourceRow), index('delivery_meeting_todos_project_status_idx').on(table.projectId, table.status, table.dueDate)])
export const deliveryMeetingTodoAnalyses = pgTable('delivery_meeting_todo_analyses', {
  id: id(), importId: uuid('import_id').notNull().references(() => deliveryMeetingTodoImports.id, { onDelete: 'cascade' }).unique(), fingerprint: text('fingerprint').notNull(), source: text('source').notNull().default('rules'), score: real('score').notNull(), level: text('level').notNull(), levelLabel: text('level_label').notNull(), metrics: jsonb('metrics').$type<Array<{ key:string; weight:number; value:number; points:number }>>().notNull().default([]), judgments: jsonb('judgments').$type<string[]>().notNull().default([]), actions: jsonb('actions').$type<string[]>().notNull().default([]), generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(), ...timestamps,
}, table => [index('delivery_meeting_todo_analyses_import_idx').on(table.importId)])

export const knowledgeBases = pgTable('knowledge_bases', {
  id: id(), projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }), accountId: text('account_id'), name: text('name').notNull(), description: text('description'), scope: text('scope').notNull().default('project'), status: text('status').notNull().default('active'), ...timestamps,
}, table => [
  uniqueIndex('knowledge_bases_project_name_uidx').on(table.projectId, table.name),
  uniqueIndex('knowledge_bases_project_uidx').on(table.projectId),
  uniqueIndex('knowledge_bases_account_uidx').on(table.accountId).where(sql`${table.accountId} is not null`),
])
export const personalMemoryEntries = pgTable('personal_memory_entries', {
  id: id(), accountId: text('account_id').notNull(), knowledgeBaseId: uuid('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }), category: text('category').notNull().default('general'), content: text('content').notNull(), sourceType: text('source_type'), sourceId: text('source_id'), occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(), importance: integer('importance').notNull().default(3), status: text('status').notNull().default('active'), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}), ...timestamps,
}, table => [index('personal_memory_account_occurred_idx').on(table.accountId, table.occurredAt)])
export const personalReports = pgTable('personal_reports', {
  id: id(), accountId: text('account_id').notNull(), knowledgeBaseId: uuid('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }), period: personalReportPeriod('period').notNull(), periodStart: date('period_start').notNull(), periodEnd: date('period_end').notNull(), title: text('title').notNull(), summary: text('summary'), content: text('content').notNull(), status: personalReportStatus('status').notNull().default('completed'), sourceSnapshot: jsonb('source_snapshot').$type<Record<string, unknown>>().notNull().default({}), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}), ...timestamps,
}, table => [uniqueIndex('personal_reports_account_period_start_uidx').on(table.accountId, table.period, table.periodStart), index('personal_reports_account_period_idx').on(table.accountId, table.period, table.periodStart)])
export const knowledgeFolders = pgTable('knowledge_folders', {
  id: id(), knowledgeBaseId: uuid('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }), parentId: uuid('parent_id'), name: text('name').notNull(), path: text('path').notNull(), sortOrder: integer('sort_order').notNull().default(0), ...timestamps,
}, table => [
  uniqueIndex('knowledge_folders_base_path_uidx').on(table.knowledgeBaseId, table.path),
])
export const documents = pgTable('documents', {
  id: id(), projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }), knowledgeBaseId: uuid('knowledge_base_id').notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }), folderId: uuid('folder_id').references(() => knowledgeFolders.id, { onDelete: 'set null' }), name: text('name').notNull(), originalName: text('original_name').notNull(), fileType: text('file_type').notNull(), mimeType: text('mime_type'), fileSize: integer('file_size'), checksum: text('checksum'), storageKey: text('storage_key'), sourcePath: text('source_path'), version: text('version').notNull().default('v1.0'), status: documentStatus('status').notNull().default('draft'), parseStatus: processingStatus('parse_status').notNull().default('pending'), indexStatus: processingStatus('index_status').notNull().default('pending'), aiEnabled: boolean('ai_enabled').notNull().default(true), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}), ...timestamps,
}, table => [index('documents_project_base_folder_status_idx').on(table.projectId, table.knowledgeBaseId, table.folderId, table.status, table.updatedAt)])
export const documentVersions = pgTable('document_versions', {
  id: id(), documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }), versionNumber: text('version_number').notNull(), storageKey: text('storage_key').notNull(), checksum: text('checksum'), fileSize: integer('file_size'), mimeType: text('mime_type'), originalName: text('original_name'), changeSummary: text('change_summary'), isCurrent: boolean('is_current').notNull().default(true), ...timestamps,
}, table => [
  uniqueIndex('document_versions_document_version_uidx').on(table.documentId, table.versionNumber),
  uniqueIndex('document_versions_current_uidx').on(table.documentId).where(sql`${table.isCurrent} = true`),
  index('document_versions_document_created_idx').on(table.documentId, table.createdAt),
])
export const documentChunks = pgTable('document_chunks', {
  id: id(), documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }), versionId: uuid('version_id').notNull().references(() => documentVersions.id, { onDelete: 'cascade' }), chunkIndex: integer('chunk_index').notNull(), title: text('title'), content: text('content').notNull(), pageNumber: integer('page_number'), sectionPath: text('section_path'), tokenCount: integer('token_count'), searchVector: tsvector('search_vector').generatedAlwaysAs(sql`to_tsvector('simple', coalesce("title", '') || ' ' || "content")`), embedding: vector('embedding', { dimensions: 1024 }), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}), ...timestamps,
}, table => [
  uniqueIndex('document_chunks_version_chunk_uidx').on(table.versionId, table.chunkIndex),
  index('document_chunks_document_version_idx').on(table.documentId, table.versionId),
  index('document_chunks_search_vector_gin_idx').using('gin', table.searchVector),
  index('document_chunks_embedding_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')).where(sql`${table.embedding} is not null`),
])

export const aiConversations = pgTable('ai_conversations', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }), title: text('title').notNull().default('新对话'), status: aiConversationStatus('status').notNull().default('active'), harnessSessionId: text('harness_session_id'), provider: text('provider'), model: text('model'), lastEventSeq: integer('last_event_seq').notNull().default(0), ...timestamps,
}, table => [
  index('ai_conversations_project_status_updated_idx').on(table.projectId, table.status, table.updatedAt),
  uniqueIndex('ai_conversations_harness_session_uidx').on(table.harnessSessionId).where(sql`${table.harnessSessionId} is not null`),
])
export const aiMessages = pgTable('ai_messages', {
  id: id(), conversationId: uuid('conversation_id').notNull().references(() => aiConversations.id, { onDelete: 'cascade' }), role: aiMessageRole('role').notNull(), content: text('content').notNull(), status: aiMessageStatus('status').notNull().default('completed'), sequence: integer('sequence').notNull(), requestId: text('request_id'), harnessEventSeq: integer('harness_event_seq'), errorCode: text('error_code'), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}), ...timestamps,
}, table => [
  uniqueIndex('ai_messages_conversation_sequence_uidx').on(table.conversationId, table.sequence),
  uniqueIndex('ai_messages_conversation_request_uidx').on(table.conversationId, table.requestId).where(sql`${table.requestId} is not null`),
  uniqueIndex('ai_messages_conversation_harness_event_uidx').on(table.conversationId, table.harnessEventSeq).where(sql`${table.harnessEventSeq} is not null`),
  index('ai_messages_conversation_created_idx').on(table.conversationId, table.createdAt),
])
export const aiMessageFeedback = pgTable('ai_message_feedback', {
  id: id(), messageId: uuid('message_id').notNull().references(() => aiMessages.id, { onDelete: 'cascade' }), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }), value: text('value').notNull(), note: text('note'), ...timestamps,
}, table => [uniqueIndex('ai_message_feedback_message_uidx').on(table.messageId), index('ai_message_feedback_project_updated_idx').on(table.projectId, table.updatedAt)])
export const aiCitations = pgTable('ai_citations', {
  id: id(), messageId: uuid('message_id').notNull().references(() => aiMessages.id, { onDelete: 'cascade' }), documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }), versionId: uuid('version_id').references(() => documentVersions.id, { onDelete: 'set null' }), chunkId: uuid('chunk_id').references(() => documentChunks.id, { onDelete: 'set null' }),
  sourceProjectId: uuid('source_project_id'), sourceProjectCode: text('source_project_code'), versionNumber: text('version_number'), chunkIndex: integer('chunk_index'), checksum: text('checksum'), capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
  sortOrder: integer('sort_order').notNull().default(0), snippet: text('snippet'), pageNumber: integer('page_number'), sectionPath: text('section_path'), score: real('score'), ...timestamps,
}, table => [index('ai_citations_message_sort_idx').on(table.messageId, table.sortOrder), index('ai_citations_source_project_idx').on(table.sourceProjectId)])

export const auditLogs = pgTable('audit_logs', {
  id: id(), projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }), entityType: text('entity_type').notNull(), entityId: uuid('entity_id'), action: text('action').notNull(), actorName: text('actor_name').notNull().default('system'), changes: jsonb('changes').$type<Record<string, unknown>>().notNull().default({}), ...timestamps,
})
export const notifications = pgTable('notifications', {
  id: id(), projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }), title: text('title').notNull(), summary: text('summary'), body: text('body'), sourceType: text('source_type').notNull(), sourceId: uuid('source_id'), recipientName: text('recipient_name'), recipientId: text('recipient_id'), readAt: timestamp('read_at', { withTimezone: true }), ...timestamps,
}, table => [index('notifications_project_created_idx').on(table.projectId, table.createdAt), index('notifications_project_read_idx').on(table.projectId, table.readAt)])

export const schema = { projects, projectPhases, tasks, taskDependencies, milestones, risks, coordinationItems, approvalItems, deliveryMeetingTodoImports, deliveryMeetingTodos, deliveryMeetingTodoAnalyses, knowledgeBases, knowledgeFolders, documents, documentVersions, documentChunks, aiConversations, aiMessages, aiMessageFeedback, aiCitations, importJobs, importBatches, importBatchEntities, importFieldChanges, auditLogs, notifications }

-- 项目计划与知识底座：建议迁移草案
-- 说明：这是设计 SQL，不直接执行。落地时应转为新的 Drizzle migration，禁止修改既有迁移。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE stakeholder_role AS ENUM ('client','contractor','vendor','consultant','supervisor','partner','other');
CREATE TYPE assignment_role AS ENUM ('owner','responsible','participant','reviewer','approver');
CREATE TYPE document_security_level AS ENUM ('internal','restricted','confidential');
CREATE TYPE risk_item_type AS ENUM ('risk','issue');

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text,
  name text NOT NULL,
  short_name text,
  organization_type text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizations_code_uidx ON organizations(code) WHERE code IS NOT NULL;
CREATE INDEX organizations_name_trgm_idx ON organizations USING gin (name gin_trgm_ops);

CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  external_user_id text,
  email text,
  mobile text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX people_organization_name_idx ON people(organization_id, name);
CREATE UNIQUE INDEX people_external_user_uidx ON people(external_user_id) WHERE external_user_id IS NOT NULL;

CREATE TABLE project_stakeholders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  role stakeholder_role NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  contact_person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, organization_id, role)
);
CREATE INDEX project_stakeholders_project_role_idx ON project_stakeholders(project_id, role);

CREATE TABLE project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  role text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  joined_on date,
  left_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, person_id, role),
  CHECK (left_on IS NULL OR joined_on IS NULL OR left_on >= joined_on)
);
CREATE INDEX project_members_project_role_idx ON project_members(project_id, role, is_primary);

CREATE TABLE work_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES work_packages(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  path text NOT NULL,
  depth integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, code),
  UNIQUE(project_id, path)
);
CREATE INDEX work_packages_project_parent_sort_idx ON work_packages(project_id, parent_id, sort_order);

ALTER TABLE tasks
  ADD COLUMN work_package_id uuid REFERENCES work_packages(id) ON DELETE SET NULL,
  ADD COLUMN delay_reason text,
  ADD COLUMN recovery_action text,
  ADD COLUMN dependency_note text,
  ADD COLUMN source_priority text,
  ADD COLUMN import_job_id uuid REFERENCES import_jobs(id) ON DELETE SET NULL,
  ADD COLUMN source_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN source_sheet text,
  ADD COLUMN source_row integer,
  ADD COLUMN source_hash text;

-- 应在迁移前先把现有 progress 由 0..1 或 0..100 统一为 0..100，再加约束。
ALTER TABLE tasks ADD CONSTRAINT tasks_progress_range_ck CHECK (progress >= 0 AND progress <= 100);
ALTER TABLE project_phases ADD CONSTRAINT project_phases_progress_range_ck CHECK (progress >= 0 AND progress <= 100);
ALTER TABLE coordination_items ADD CONSTRAINT coordination_progress_range_ck CHECK (progress >= 0 AND progress <= 100);

CREATE INDEX tasks_project_status_end_idx ON tasks(project_id, status, planned_end_date);
CREATE INDEX tasks_project_phase_sort_idx ON tasks(project_id, phase_id, wbs_code);
CREATE INDEX tasks_project_work_package_sort_idx ON tasks(project_id, work_package_id, wbs_code);
CREATE INDEX tasks_project_parent_idx ON tasks(project_id, parent_id);
CREATE INDEX tasks_import_source_idx ON tasks(import_job_id, source_sheet, source_row);

ALTER TABLE task_dependencies
  ADD CONSTRAINT task_dependencies_not_self_ck CHECK (predecessor_id <> successor_id);
CREATE UNIQUE INDEX task_dependencies_pair_type_uidx ON task_dependencies(predecessor_id, successor_id, type);
CREATE INDEX task_dependencies_successor_idx ON task_dependencies(successor_id);

CREATE TABLE task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_member_id uuid NOT NULL REFERENCES project_members(id) ON DELETE RESTRICT,
  role assignment_role NOT NULL DEFAULT 'responsible',
  allocation_percent numeric(5,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, project_member_id, role),
  CHECK (allocation_percent IS NULL OR allocation_percent BETWEEN 0 AND 100)
);
CREATE INDEX task_assignments_project_member_idx ON task_assignments(project_id, project_member_id);

CREATE TABLE task_deliverables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'planned',
  due_date date,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_deliverables_task_status_idx ON task_deliverables(task_id, status, due_date);

ALTER TABLE milestones ADD COLUMN planned_start_date date;
ALTER TABLE milestones ADD COLUMN is_key boolean NOT NULL DEFAULT false;
CREATE INDEX milestones_project_active_date_idx ON milestones(project_id, status, planned_date)
  WHERE status NOT IN ('completed','cancelled');

ALTER TABLE risks ADD COLUMN item_type risk_item_type NOT NULL DEFAULT 'risk';
ALTER TABLE risks ADD COLUMN probability_percent numeric(5,2);
ALTER TABLE risks ADD COLUMN probability_level text;
ALTER TABLE risks ADD COLUMN resolution_note text;
ALTER TABLE risks ADD CONSTRAINT risks_probability_range_ck
  CHECK (probability_percent IS NULL OR probability_percent BETWEEN 0 AND 100);
CREATE INDEX risks_project_active_due_idx ON risks(project_id, level, expected_resolution_date)
  WHERE status NOT IN ('closed','accepted');

ALTER TABLE coordination_items ADD COLUMN impact text;
ALTER TABLE coordination_items ADD COLUMN support_required text;
ALTER TABLE coordination_items ADD COLUMN decision_required text;
CREATE INDEX coordination_project_active_due_idx ON coordination_items(project_id, priority, due_date)
  WHERE status <> 'closed';
CREATE INDEX approval_project_active_end_idx ON approval_items(project_id, status, planned_end_date)
  WHERE status NOT IN ('completed','closed','cancelled');

CREATE TABLE weekly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  completion_summary text,
  submitted_by uuid REFERENCES project_members(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft',
  source_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, period_start, period_end),
  CHECK(period_end >= period_start)
);
CREATE INDEX weekly_reports_project_period_idx ON weekly_reports(project_id, period_end DESC);

CREATE TABLE weekly_plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  weekly_report_id uuid NOT NULL REFERENCES weekly_reports(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  description text NOT NULL,
  contractor_text text,
  owner_text text,
  planned_start_date date,
  planned_end_date date,
  deliverable text,
  dependency_note text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX weekly_plan_items_report_sort_idx ON weekly_plan_items(weekly_report_id, sort_order);

ALTER TABLE import_jobs ADD COLUMN source_document_id uuid REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE import_jobs ADD COLUMN template_version text;
ALTER TABLE import_jobs ADD COLUMN mapping_version text;
ALTER TABLE import_jobs ADD COLUMN idempotency_key text;
ALTER TABLE import_jobs ADD COLUMN started_at timestamptz;
ALTER TABLE import_jobs ADD COLUMN finished_at timestamptz;
CREATE UNIQUE INDEX import_jobs_idempotency_uidx ON import_jobs(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX import_jobs_project_created_idx ON import_jobs(project_id, created_at DESC);

CREATE TABLE import_row_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_job_id uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  source_sheet text NOT NULL,
  source_row integer NOT NULL CHECK(source_row > 0),
  source_hash text NOT NULL,
  target_entity_type text,
  target_entity_id uuid,
  raw_payload jsonb NOT NULL,
  normalized_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status processing_status NOT NULL DEFAULT 'pending',
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_job_id, source_sheet, source_row)
);
CREATE INDEX import_rows_project_hash_idx ON import_row_records(project_id, source_hash);
CREATE INDEX import_rows_target_idx ON import_row_records(project_id, target_entity_type, target_entity_id);

ALTER TABLE documents ADD COLUMN document_type text NOT NULL DEFAULT 'other';
ALTER TABLE documents ADD COLUMN security_level document_security_level NOT NULL DEFAULT 'internal';
ALTER TABLE documents ADD COLUMN retention_until date;
CREATE INDEX documents_project_type_status_updated_idx
  ON documents(project_id, document_type, status, updated_at DESC);
CREATE INDEX documents_metadata_gin_idx ON documents USING gin(metadata jsonb_path_ops);

CREATE TABLE document_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  relation_type text NOT NULL DEFAULT 'related',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id, entity_type, entity_id, relation_type)
);
CREATE INDEX document_relations_entity_idx ON document_relations(project_id, entity_type, entity_id);

CREATE TABLE document_acl (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  permission text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id, subject_type, subject_id, permission)
);
CREATE INDEX document_acl_subject_idx ON document_acl(project_id, subject_type, subject_id);

CREATE TABLE embedding_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK(dimensions > 0),
  normalization text,
  pipeline_version text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, model, dimensions, pipeline_version)
);

CREATE TABLE knowledge_index_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  embedding_model_id uuid REFERENCES embedding_models(id) ON DELETE RESTRICT,
  pipeline_version text NOT NULL,
  status processing_status NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(version_id, pipeline_version, embedding_model_id)
);
CREATE INDEX knowledge_jobs_project_status_created_idx
  ON knowledge_index_jobs(project_id, status, created_at);

-- 为向量查询预留项目过滤列。回填并验证一致性后再设 NOT NULL。
ALTER TABLE document_chunks ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE document_chunks ADD COLUMN knowledge_base_id uuid REFERENCES knowledge_bases(id) ON DELETE CASCADE;
CREATE INDEX document_chunks_project_version_idx
  ON document_chunks(project_id, document_id, version_id, chunk_index);
CREATE INDEX document_chunks_metadata_gin_idx
  ON document_chunks USING gin(metadata jsonb_path_ops);

-- 可选：规模达到千万级 chunk 后，再按 project_id 哈希分区重建 document_chunks；
-- 小规模阶段不要过早分区，先用项目过滤 + HNSW + 当前版本条件验证查询计划。

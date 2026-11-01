-- ICT-1 project import batches and append-only field ledger.
-- Expand-only migration: existing import_jobs/tasks are preserved; rollback disables callers
-- and may drop these empty tables only before any batch is produced. Applied ledgers are never deleted.
CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app text NOT NULL CHECK (app IN ('project', 'opportunity')),
  scope_type text NOT NULL,
  scope_id uuid NOT NULL,
  kind text NOT NULL,
  mode text NOT NULL DEFAULT 'snapshot' CHECK (mode IN ('snapshot', 'rollback')),
  source_name text NOT NULL,
  source_checksum text NOT NULL,
  mapping_version text NOT NULL DEFAULT 'ICT-1',
  normalization_version text NOT NULL DEFAULT 'ICT-1',
  base_batch_id uuid REFERENCES import_batches(id),
  preview_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','validating','applying','succeeded','failed','cancelled')),
  counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id text,
  actor_name text,
  request_id text,
  rollback_of_batch_id uuid REFERENCES import_batches(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS import_batches_scope_kind_created_idx ON import_batches(scope_id, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS import_batches_success_idempotency_uidx
  ON import_batches(app, scope_id, kind, source_checksum, COALESCE(base_batch_id, '00000000-0000-0000-0000-000000000000'::uuid), mapping_version)
  WHERE status = 'succeeded';

CREATE TABLE IF NOT EXISTS import_batch_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES import_batches(id),
  entity_type text NOT NULL,
  business_key text NOT NULL,
  target_entity_id uuid,
  source_sheet text,
  source_row integer,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_hash text NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('initial','unchanged','created','modified','cleared','archived')),
  max_severity text NOT NULL DEFAULT 'info' CHECK (max_severity IN ('info','low','medium','high','critical')),
  changed_field_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, entity_type, business_key)
);
CREATE INDEX IF NOT EXISTS import_batch_entities_target_created_idx ON import_batch_entities(target_entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS import_field_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES import_batches(id),
  batch_entity_id uuid NOT NULL REFERENCES import_batch_entities(id),
  entity_type text NOT NULL,
  business_key text NOT NULL,
  target_entity_id uuid,
  field_key text NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('initial','created','modified','cleared','archived')),
  direction text NOT NULL CHECK (direction IN ('increase','decrease','postponed','advanced','from_empty','to_empty','state_forward','state_backward','changed','none')),
  severity text NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  old_value_json jsonb,
  new_value_json jsonb,
  old_display text,
  new_display text,
  derived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, entity_type, business_key, field_key)
);
CREATE INDEX IF NOT EXISTS import_field_changes_batch_severity_idx ON import_field_changes(batch_id, severity);
CREATE INDEX IF NOT EXISTS import_field_changes_target_created_idx ON import_field_changes(target_entity_id, created_at DESC);

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  total_rows bigint := 0;
  relation_name text;
  relation_count bigint;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'public.import_batches',
    'public.import_batch_entities',
    'public.import_field_changes',
    'opportunity.import_batches',
    'opportunity.import_batch_entities',
    'opportunity.import_field_changes',
    'opportunity.import_scope_currents',
    'opportunity.import_audit_events'
  ] LOOP
    IF to_regclass(relation_name) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %s', relation_name) INTO relation_count;
      total_rows := total_rows + relation_count;
    END IF;
  END LOOP;
  IF total_rows <> 0 THEN
    RAISE EXCEPTION 'ict_empty_rollback_refused: % rows exist', total_rows;
  END IF;
END $$;

DROP TABLE IF EXISTS opportunity.import_audit_events;
DROP TABLE IF EXISTS opportunity.import_scope_currents;
DROP TABLE IF EXISTS opportunity.import_field_changes;
DROP TABLE IF EXISTS opportunity.import_batch_entities;
DROP TABLE IF EXISTS opportunity.import_batches;
DROP INDEX IF EXISTS opportunity.opportunities_current_tenant_idx;
ALTER TABLE opportunity.opportunities
  DROP COLUMN IF EXISTS latest_import_batch_id,
  DROP COLUMN IF EXISTS archived_at,
  DROP COLUMN IF EXISTS is_current,
  DROP COLUMN IF EXISTS customer_snapshot;

DROP TABLE IF EXISTS public.import_field_changes;
DROP TABLE IF EXISTS public.import_batch_entities;
DROP TABLE IF EXISTS public.import_batches;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1789202600000;

DO $$
BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 20 THEN
    RAISE EXCEPTION 'ict_empty_rollback_journal_invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE (table_schema = 'public' AND table_name IN ('import_batches','import_batch_entities','import_field_changes'))
       OR (table_schema = 'opportunity' AND table_name IN ('import_batches','import_batch_entities','import_field_changes','import_scope_currents','import_audit_events'))
  ) THEN
    RAISE EXCEPTION 'ict_empty_rollback_structure_remains';
  END IF;
END $$;

COMMIT;

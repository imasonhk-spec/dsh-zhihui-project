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
    'public.import_field_changes'
  ] LOOP
    IF to_regclass(relation_name) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %s', relation_name) INTO relation_count;
      total_rows := total_rows + relation_count;
    END IF;
  END LOOP;
  IF total_rows <> 0 THEN
    RAISE EXCEPTION 'ict_project_empty_rollback_refused: % rows exist', total_rows;
  END IF;
END $$;

DROP TABLE IF EXISTS public.import_field_changes;
DROP TABLE IF EXISTS public.import_batch_entities;
DROP TABLE IF EXISTS public.import_batches;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1789202600000;

DO $$
BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 20 THEN
    RAISE EXCEPTION 'ict_project_empty_rollback_journal_invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('import_batches','import_batch_entities','import_field_changes')
  ) THEN
    RAISE EXCEPTION 'ict_project_empty_rollback_structure_remains';
  END IF;
  IF to_regclass('public.import_jobs') IS NULL THEN
    RAISE EXCEPTION 'ict_project_empty_rollback_import_jobs_missing';
  END IF;
  IF (SELECT count(*) FROM public.import_jobs) <> 268 THEN
    RAISE EXCEPTION 'ict_project_empty_rollback_import_jobs_changed';
  END IF;
  IF (SELECT count(*) FROM information_schema.tables WHERE table_schema='opportunity' AND table_name IN ('import_batches','import_batch_entities','import_field_changes','import_scope_currents','import_audit_events')) <> 5 THEN
    RAISE EXCEPTION 'ict_project_empty_rollback_opportunity_structure_changed';
  END IF;
  IF (SELECT count(*) FROM opportunity.import_batches) <> 2
     OR (SELECT count(*) FROM opportunity.import_batch_entities) <> 128
     OR (SELECT count(*) FROM opportunity.import_field_changes) <> 813
     OR (SELECT count(*) FROM opportunity.import_scope_currents) <> 1
     OR (SELECT count(*) FROM opportunity.import_audit_events) <> 5 THEN
    RAISE EXCEPTION 'ict_project_empty_rollback_opportunity_ledger_changed';
  END IF;
END $$;

COMMIT;

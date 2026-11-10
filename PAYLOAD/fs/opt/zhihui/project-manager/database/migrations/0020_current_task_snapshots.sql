ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS snapshot_id uuid REFERENCES import_jobs(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE project_phases ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
ALTER TABLE project_phases ADD COLUMN IF NOT EXISTS snapshot_id uuid REFERENCES import_jobs(id) ON DELETE SET NULL;
ALTER TABLE project_phases ADD COLUMN IF NOT EXISTS archived_at timestamptz;

DROP INDEX IF EXISTS tasks_project_wbs_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_current_wbs_uidx
  ON tasks(project_id, wbs_code)
  WHERE is_current = true;
CREATE INDEX IF NOT EXISTS tasks_project_current_idx ON tasks(project_id, is_current);
CREATE INDEX IF NOT EXISTS tasks_snapshot_idx ON tasks(snapshot_id);
CREATE INDEX IF NOT EXISTS project_phases_project_current_idx ON project_phases(project_id, is_current);
CREATE INDEX IF NOT EXISTS project_phases_snapshot_idx ON project_phases(snapshot_id);

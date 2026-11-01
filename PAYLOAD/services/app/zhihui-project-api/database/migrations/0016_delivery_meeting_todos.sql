-- 项目交付中心周会待办导入批次与明细
CREATE TABLE IF NOT EXISTS delivery_meeting_todo_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL,
  checksum text NOT NULL UNIQUE,
  total_rows integer NOT NULL DEFAULT 0,
  matched_rows integer NOT NULL DEFAULT 0,
  unmatched_rows integer NOT NULL DEFAULT 0,
  imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_meeting_todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES delivery_meeting_todo_imports(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  source_row integer NOT NULL,
  sequence integer,
  established_date date,
  title text NOT NULL,
  owner_name text,
  deadline_text text,
  due_date date,
  project_name_raw text,
  status text NOT NULL DEFAULT 'pending',
  result_remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_meeting_todos_import_row_uidx UNIQUE (import_id, source_row)
);

CREATE INDEX IF NOT EXISTS delivery_meeting_todos_project_status_idx ON delivery_meeting_todos(project_id, status, due_date);
CREATE INDEX IF NOT EXISTS delivery_meeting_todos_import_idx ON delivery_meeting_todos(import_id, source_row);

CREATE TABLE IF NOT EXISTS delivery_meeting_todo_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL UNIQUE REFERENCES delivery_meeting_todo_imports(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  source text NOT NULL DEFAULT 'rules',
  score real NOT NULL,
  level text NOT NULL,
  level_label text NOT NULL,
  metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  judgments jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_meeting_todo_analyses_import_idx ON delivery_meeting_todo_analyses(import_id);

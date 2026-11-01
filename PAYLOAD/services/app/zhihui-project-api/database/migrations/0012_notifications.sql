CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "title" text NOT NULL,
  "summary" text,
  "body" text,
  "source_type" text NOT NULL,
  "source_id" uuid,
  "recipient_name" text,
  "recipient_id" text,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_project_created_idx" ON "notifications" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_project_read_idx" ON "notifications" USING btree ("project_id","read_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_notification_from_audit() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    INSERT INTO notifications (project_id, title, summary, body, source_type, source_id, recipient_name, recipient_id, created_at, updated_at)
    VALUES (
      NEW.project_id,
      CASE NEW.entity_type
        WHEN 'project' THEN '项目'
        WHEN 'phase' THEN '阶段'
        WHEN 'task' THEN '任务'
        WHEN 'dependency' THEN '任务依赖'
        WHEN 'milestone' THEN '里程碑'
        WHEN 'risk' THEN '风险'
        WHEN 'coordination' THEN '协调事项'
        WHEN 'approval' THEN '报批'
        WHEN 'folder' THEN '知识库目录'
        WHEN 'document' THEN '文档'
        ELSE NEW.entity_type
      END || CASE NEW.action
        WHEN 'created' THEN '新增'
        WHEN 'updated' THEN '更新'
        WHEN 'status_changed' THEN '状态变更'
        WHEN 'progress_changed' THEN '进度变更'
        WHEN 'closed' THEN '关闭'
        WHEN 'resolved' THEN '解决'
        WHEN 'archived' THEN '归档'
        WHEN 'deleted' THEN '删除'
        ELSE NEW.action
      END,
      COALESCE(NEW.changes->>'summary', NEW.changes->>'name', NEW.changes->>'title'),
      COALESCE(NEW.changes->>'summary', NEW.changes->>'name', NEW.changes->>'title'),
      NEW.entity_type,
      NEW.entity_id,
      NEW.actor_name,
      NULL,
      NEW.created_at,
      NEW.created_at
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_logs_create_notification AFTER INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION create_notification_from_audit();--> statement-breakpoint
INSERT INTO notifications (project_id, title, summary, body, source_type, source_id, recipient_name, created_at, updated_at)
SELECT a.project_id,
       CASE a.entity_type WHEN 'project' THEN '项目' WHEN 'phase' THEN '阶段' WHEN 'task' THEN '任务' WHEN 'milestone' THEN '里程碑' WHEN 'risk' THEN '风险' WHEN 'coordination' THEN '协调事项' WHEN 'approval' THEN '报批' WHEN 'folder' THEN '知识库目录' WHEN 'document' THEN '文档' ELSE a.entity_type END || a.action,
       COALESCE(a.changes->>'summary', a.changes->>'name', a.changes->>'title'),
       COALESCE(a.changes->>'summary', a.changes->>'name', a.changes->>'title'),
       a.entity_type, a.entity_id, a.actor_name, a.created_at, a.created_at
FROM audit_logs a LEFT JOIN notifications n ON n.source_type = a.entity_type AND n.source_id = a.entity_id AND n.created_at = a.created_at
WHERE a.project_id IS NOT NULL AND n.id IS NULL;

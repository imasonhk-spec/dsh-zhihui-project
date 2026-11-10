CREATE TABLE "ai_message_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "value" text NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_message_feedback_value_check" CHECK ("value" IN ('helpful','unhelpful'))
);--> statement-breakpoint
ALTER TABLE "ai_message_feedback" ADD CONSTRAINT "ai_message_feedback_message_id_ai_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ai_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_message_feedback" ADD CONSTRAINT "ai_message_feedback_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_message_feedback_message_uidx" ON "ai_message_feedback" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ai_message_feedback_project_updated_idx" ON "ai_message_feedback" USING btree ("project_id","updated_at");
CREATE TYPE "public"."ai_conversation_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."ai_message_role" AS ENUM('system', 'user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."ai_message_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
DELETE FROM "ai_conversations" WHERE "project_id" IS NULL;--> statement-breakpoint
UPDATE "ai_conversations" SET "title" = '新对话' WHERE "title" IS NULL OR btrim("title") = '';--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "status" "ai_conversation_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" ALTER COLUMN "project_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ai_conversations" ALTER COLUMN "title" SET DEFAULT '新对话';--> statement-breakpoint
ALTER TABLE "ai_conversations" ALTER COLUMN "title" SET NOT NULL;--> statement-breakpoint
UPDATE "ai_conversations" SET "last_event_seq" = 0 WHERE "last_event_seq" IS NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" ALTER COLUMN "last_event_seq" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "ai_conversations" ALTER COLUMN "last_event_seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" DROP CONSTRAINT "ai_conversations_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "error_code" text;--> statement-breakpoint
WITH numbered AS (SELECT "id", row_number() OVER (PARTITION BY "conversation_id" ORDER BY "created_at", "id") AS seq FROM "ai_messages") UPDATE "ai_messages" SET "sequence" = numbered.seq FROM numbered WHERE "ai_messages"."id" = numbered."id";--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "role" TYPE "ai_message_role" USING "role"::"ai_message_role";--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "status" TYPE "ai_message_status" USING "status"::"ai_message_status";--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "status" SET DEFAULT 'completed';--> statement-breakpoint
ALTER TABLE "ai_citations" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD COLUMN "score" real;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversations_project_status_updated_idx" ON "ai_conversations" USING btree ("project_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversations_harness_session_uidx" ON "ai_conversations" USING btree ("harness_session_id") WHERE "harness_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_conversation_sequence_uidx" ON "ai_messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_created_idx" ON "ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_citations_message_sort_idx" ON "ai_citations" USING btree ("message_id","sort_order");
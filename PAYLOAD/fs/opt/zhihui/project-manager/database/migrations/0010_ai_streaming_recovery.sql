ALTER TABLE "ai_messages" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "harness_event_seq" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_conversation_request_uidx" ON "ai_messages" USING btree ("conversation_id","request_id") WHERE "request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_conversation_harness_event_uidx" ON "ai_messages" USING btree ("conversation_id","harness_event_seq") WHERE "harness_event_seq" is not null;
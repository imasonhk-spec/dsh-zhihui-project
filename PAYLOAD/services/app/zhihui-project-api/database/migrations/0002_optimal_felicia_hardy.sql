ALTER TABLE "approval_items" ADD COLUMN "actual_start_date" date;--> statement-breakpoint
ALTER TABLE "approval_items" ADD COLUMN "actual_end_date" date;--> statement-breakpoint
ALTER TABLE "approval_items" ADD COLUMN "result" text;--> statement-breakpoint
ALTER TABLE "approval_items" ADD COLUMN "remark" text;--> statement-breakpoint
ALTER TABLE "approval_items" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;
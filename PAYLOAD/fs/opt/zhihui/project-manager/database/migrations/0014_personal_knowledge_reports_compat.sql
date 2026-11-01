ALTER TABLE "knowledge_bases" ADD COLUMN IF NOT EXISTS "account_id" text;
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_bases_account_uidx" ON "knowledge_bases" USING btree ("account_id") WHERE "account_id" IS NOT NULL;
DO $$ BEGIN
  CREATE TYPE "public"."personal_report_period" AS ENUM('daily', 'weekly', 'monthly');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."personal_report_status" AS ENUM('draft', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS "personal_memory_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" text NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "category" text DEFAULT 'general' NOT NULL,
  "content" text NOT NULL,
  "source_type" text,
  "source_id" text,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "importance" integer DEFAULT 3 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "personal_memory_entries" ADD CONSTRAINT "personal_memory_entries_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "personal_memory_account_occurred_idx" ON "personal_memory_entries" USING btree ("account_id", "occurred_at");
CREATE TABLE IF NOT EXISTS "personal_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" text NOT NULL,
  "knowledge_base_id" uuid NOT NULL,
  "period" "personal_report_period" NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "title" text NOT NULL,
  "summary" text,
  "content" text NOT NULL,
  "status" "personal_report_status" DEFAULT 'completed' NOT NULL,
  "source_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "personal_reports" ADD CONSTRAINT "personal_reports_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "personal_reports_account_period_start_uidx" ON "personal_reports" USING btree ("account_id", "period", "period_start");
CREATE INDEX IF NOT EXISTS "personal_reports_account_period_idx" ON "personal_reports" USING btree ("account_id", "period", "period_start");

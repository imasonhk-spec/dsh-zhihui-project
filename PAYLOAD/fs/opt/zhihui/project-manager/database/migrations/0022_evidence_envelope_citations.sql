ALTER TABLE "ai_citations" ADD COLUMN IF NOT EXISTS "source_project_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_citations" ADD COLUMN IF NOT EXISTS "source_project_code" text;
--> statement-breakpoint
ALTER TABLE "ai_citations" ADD COLUMN IF NOT EXISTS "version_number" text;
--> statement-breakpoint
ALTER TABLE "ai_citations" ADD COLUMN IF NOT EXISTS "chunk_index" integer;
--> statement-breakpoint
ALTER TABLE "ai_citations" ADD COLUMN IF NOT EXISTS "checksum" text;
--> statement-breakpoint
ALTER TABLE "ai_citations" ADD COLUMN IF NOT EXISTS "captured_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_citations_source_project_idx" ON "ai_citations" USING btree ("source_project_id");
--> statement-breakpoint
UPDATE "ai_citations" c
SET "source_project_id" = coalesce(c."source_project_id", d."project_id"),
    "source_project_code" = coalesce(c."source_project_code", p."code"),
    "version_number" = coalesce(c."version_number", (SELECT dv."version_number" FROM "document_versions" dv WHERE dv."id" = c."version_id")),
    "chunk_index" = coalesce(c."chunk_index", (SELECT dc."chunk_index" FROM "document_chunks" dc WHERE dc."id" = c."chunk_id")),
    "checksum" = coalesce(c."checksum", (SELECT dv."checksum" FROM "document_versions" dv WHERE dv."id" = c."version_id"), d."checksum"),
    "captured_at" = coalesce(c."captured_at", c."created_at")
FROM "documents" d
LEFT JOIN "projects" p ON p."id" = d."project_id"
WHERE d."id" = c."document_id"
  AND (c."source_project_id" IS NULL OR c."source_project_code" IS NULL OR c."version_number" IS NULL OR c."chunk_index" IS NULL OR c."checksum" IS NULL OR c."captured_at" IS NULL);
--> statement-breakpoint
UPDATE "ai_citations" SET "captured_at" = "created_at" WHERE "captured_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "ai_citations" ALTER COLUMN "captured_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "ai_citations" ALTER COLUMN "captured_at" SET NOT NULL;

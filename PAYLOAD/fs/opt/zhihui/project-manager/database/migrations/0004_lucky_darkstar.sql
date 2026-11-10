ALTER TABLE "document_versions" ADD COLUMN "file_size" integer;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "original_name" text;--> statement-breakpoint
UPDATE "document_versions" v SET
  "file_size" = d."file_size",
  "mime_type" = d."mime_type",
  "original_name" = d."original_name"
FROM "documents" d
WHERE v."document_id" = d."id" AND v."is_current" = true;
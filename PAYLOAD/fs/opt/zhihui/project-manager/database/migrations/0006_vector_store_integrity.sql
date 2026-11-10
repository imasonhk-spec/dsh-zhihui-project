ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_id_document_uidx" UNIQUE("id", "document_id");--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_version_document_fk" FOREIGN KEY ("version_id", "document_id") REFERENCES "document_versions"("id", "document_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_index_nonnegative_chk" CHECK ("chunk_index" >= 0);--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_page_positive_chk" CHECK ("page_number" IS NULL OR "page_number" >= 1);--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_token_nonnegative_chk" CHECK ("token_count" IS NULL OR "token_count" >= 0);--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_content_nonblank_chk" CHECK (btrim("content") <> '');

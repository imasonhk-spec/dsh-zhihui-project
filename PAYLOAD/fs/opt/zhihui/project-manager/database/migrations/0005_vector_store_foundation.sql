ALTER TABLE "document_chunks" ALTER COLUMN "version_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunks_version_chunk_uidx" ON "document_chunks" USING btree ("version_id","chunk_index");--> statement-breakpoint
CREATE INDEX "document_chunks_document_version_idx" ON "document_chunks" USING btree ("document_id","version_id");--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_hnsw_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops) WHERE "document_chunks"."embedding" is not null;
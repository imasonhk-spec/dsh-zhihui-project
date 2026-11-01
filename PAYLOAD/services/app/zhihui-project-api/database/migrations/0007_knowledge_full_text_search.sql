ALTER TABLE "document_chunks" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || "content")) STORED;--> statement-breakpoint
CREATE INDEX "document_chunks_search_vector_gin_idx" ON "document_chunks" USING gin ("search_vector");

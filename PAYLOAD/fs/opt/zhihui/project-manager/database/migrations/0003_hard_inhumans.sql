CREATE UNIQUE INDEX "document_versions_document_version_uidx" ON "document_versions" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_current_uidx" ON "document_versions" USING btree ("document_id") WHERE "document_versions"."is_current" = true;--> statement-breakpoint
CREATE INDEX "document_versions_document_created_idx" ON "document_versions" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_project_base_folder_status_idx" ON "documents" USING btree ("project_id","knowledge_base_id","folder_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_bases_project_uidx" ON "knowledge_bases" USING btree ("project_id");
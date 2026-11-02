ALTER TABLE "audit_log" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "events_outbox" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
CREATE INDEX "leave_requests_approver_status_idx" ON "leave_requests" USING btree ("approver_id","status");--> statement-breakpoint
CREATE INDEX "leave_requests_company_status_idx" ON "leave_requests" USING btree ("company_id","status");
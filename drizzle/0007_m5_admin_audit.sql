ALTER TABLE "audit_log" ADD COLUMN "subject_user_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: rows written before M5 name their person through the entity they audit.
UPDATE "audit_log" a SET "subject_user_id" = lr."user_id"
FROM "leave_requests" lr
WHERE a."entity_type" = 'leave_request' AND a."entity_id" = lr."id"::text;--> statement-breakpoint
UPDATE "audit_log" a SET "subject_user_id" = al."user_id"
FROM "allowances" al
WHERE a."entity_type" = 'allowance' AND a."entity_id" = al."id"::text;--> statement-breakpoint
UPDATE "audit_log" a SET "subject_user_id" = f."user_id"
FROM "calendar_feed_tokens" f
WHERE a."entity_type" = 'calendar_feed' AND a."entity_id" = f."id"::text;--> statement-breakpoint
CREATE INDEX "audit_log_company_created_idx" ON "audit_log" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_log_company_action_idx" ON "audit_log" USING btree ("company_id","action","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_log_company_actor_idx" ON "audit_log" USING btree ("company_id","actor_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_log_company_subject_idx" ON "audit_log" USING btree ("company_id","subject_user_id","created_at","id");--> statement-breakpoint
ALTER TABLE "allowances" ADD CONSTRAINT "allowances_days_nonneg" CHECK ("allowances"."days" >= 0);--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_default_allowance_nonneg" CHECK ("leave_types"."default_allowance_days" >= 0);--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_carryover_max_nonneg" CHECK ("leave_types"."carryover_max_days" >= 0);
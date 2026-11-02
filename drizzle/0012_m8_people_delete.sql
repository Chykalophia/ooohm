ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_shape";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_requested_by" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "deletion_grace" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "deletion_mode" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "scrub_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "scrub_requested_by" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_requested_by_user_id_fk" FOREIGN KEY ("actor_requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_scrub_requested_by_user_id_fk" FOREIGN KEY ("scrub_requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_scrub_scheduled_idx" ON "user" USING btree ("scrub_scheduled_at") WHERE "user"."scrub_scheduled_at" is not null;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_shape" CHECK (("audit_log"."actor_kind" = 'system' and "audit_log"."actor_process" is not null and "audit_log"."actor_id" is null and "audit_log"."api_key_id" is null and "audit_log"."actor_via" is null)
        or ("audit_log"."actor_kind" = 'user' and "audit_log"."actor_process" is null and "audit_log"."api_key_id" is null and "audit_log"."actor_requested_by" is null)
        or ("audit_log"."actor_kind" = 'api_key' and "audit_log"."actor_process" is null and "audit_log"."actor_requested_by" is null));--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_deletion_shape" CHECK (("user"."deleted_at" is null and "user"."deletion_mode" is null)
        or ("user"."deleted_at" is not null and "user"."deletion_mode" in ('scrubbed', 'records_kept') and not "user"."is_active"));--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_scrub_schedule_shape" CHECK (("user"."scrub_scheduled_at" is null and "user"."scrub_requested_by" is null)
        or ("user"."scrub_scheduled_at" is not null and "user"."deleted_at" is null and not "user"."is_active"));
ALTER TABLE "departments" ADD COLUMN "manager_id" text;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_manager_id_user_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "departments_manager_idx" ON "departments" USING btree ("manager_id");
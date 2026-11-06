CREATE TABLE "allowance_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"department_id" uuid,
	"level_id" uuid,
	"days" numeric(5, 1) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowance_rules_target_uq" UNIQUE NULLS NOT DISTINCT("leave_type_id","department_id","level_id"),
	CONSTRAINT "allowance_rules_target" CHECK ("allowance_rules"."department_id" is not null or "allowance_rules"."level_id" is not null),
	CONSTRAINT "allowance_rules_days_nonneg" CHECK ("allowance_rules"."days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "level_id" uuid;--> statement-breakpoint
ALTER TABLE "allowance_rules" ADD CONSTRAINT "allowance_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_rules" ADD CONSTRAINT "allowance_rules_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_rules" ADD CONSTRAINT "allowance_rules_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_rules" ADD CONSTRAINT "allowance_rules_level_id_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."levels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "levels" ADD CONSTRAINT "levels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allowance_rules_company_idx" ON "allowance_rules" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "levels_company_lower_name_uq" ON "levels" USING btree ("company_id",lower("name"));--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_level_id_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."levels"("id") ON DELETE set null ON UPDATE no action;
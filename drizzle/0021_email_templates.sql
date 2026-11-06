CREATE TABLE "email_templates" (
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"subject" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_templates_company_id_type_pk" PRIMARY KEY("company_id","type"),
	CONSTRAINT "email_templates_some_copy" CHECK ("email_templates"."subject" is not null or "email_templates"."message" is not null)
);
--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
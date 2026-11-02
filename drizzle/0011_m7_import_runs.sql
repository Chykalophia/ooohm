CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_sha256" text NOT NULL,
	"source_file_name" text NOT NULL,
	"counts" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_runs_sha256_format" CHECK ("import_runs"."source_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_runs_source_sha256_uq" ON "import_runs" USING btree ("source_sha256");--> statement-breakpoint
CREATE INDEX "import_runs_company_idx" ON "import_runs" USING btree ("company_id","created_at");
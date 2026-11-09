ALTER TABLE "companies" ADD COLUMN "logo" bytea;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "logo_sha256" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "logo_type" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "logo_width" integer;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "logo_height" integer;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_logo_complete" CHECK (num_nulls("companies"."logo", "companies"."logo_sha256", "companies"."logo_type", "companies"."logo_width", "companies"."logo_height") in (0, 5));
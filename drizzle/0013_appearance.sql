ALTER TABLE "companies" ADD COLUMN "theme" text DEFAULT 'classic' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "accent_color" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "corners" text DEFAULT 'theme' NOT NULL;
CREATE TYPE "public"."theme" AS ENUM('light', 'dark', 'system');--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "theme" "theme" DEFAULT 'light' NOT NULL;
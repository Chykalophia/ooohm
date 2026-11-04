CREATE TABLE "installation" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	CONSTRAINT "installation_single_row" CHECK ("installation"."id" = 1)
);

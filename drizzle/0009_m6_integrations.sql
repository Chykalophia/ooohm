CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'delivered', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "adapter_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"adapter_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{read}'::text[] NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_format" CHECK ("api_keys"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_keys_scopes_known" CHECK (cardinality("api_keys"."scopes") > 0 and "api_keys"."scopes" <@ array['read', 'write']::text[])
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"name" text PRIMARY KEY NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"body" text NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_status_code" integer,
	"last_latency_ms" integer,
	"last_error" text,
	"last_response_excerpt" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"event_types" text[] NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_event_types_nonempty" CHECK (cardinality("webhook_endpoints"."event_types") > 0)
);
--> statement-breakpoint
DROP INDEX "events_outbox_pending_idx";--> statement-breakpoint
DROP INDEX "user_company_idx";--> statement-breakpoint
ALTER TABLE "events_outbox" ADD COLUMN "tx_id" bigint DEFAULT pg_current_xact_id()::text::bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_deliveries" ADD CONSTRAINT "adapter_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_deliveries" ADD CONSTRAINT "adapter_deliveries_event_id_events_outbox_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_deliveries_adapter_event_uq" ON "adapter_deliveries" USING btree ("adapter_id","event_id");--> statement-breakpoint
CREATE INDEX "adapter_deliveries_due_idx" ON "adapter_deliveries" USING btree ("next_attempt_at","id") WHERE "adapter_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "adapter_deliveries_event_idx" ON "adapter_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_company_created_idx" ON "api_keys" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event_uq" ON "webhook_deliveries" USING btree ("endpoint_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at","id") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_created_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at","id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_company_idx" ON "webhook_endpoints" USING btree ("company_id","created_at") WHERE "webhook_endpoints"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "events_outbox_undispatched_idx" ON "events_outbox" USING btree ("created_at","id") WHERE "events_outbox"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "events_outbox_company_tx_idx" ON "events_outbox" USING btree ("company_id","tx_id","created_at","id");--> statement-breakpoint
CREATE INDEX "leave_requests_company_start_id_idx" ON "leave_requests" USING btree ("company_id","start_date","id");--> statement-breakpoint
CREATE INDEX "user_company_id_idx" ON "user" USING btree ("company_id","id");
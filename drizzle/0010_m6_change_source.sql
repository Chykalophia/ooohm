ALTER TABLE "audit_log" ADD COLUMN "actor_kind" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_via" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_process" text;--> statement-breakpoint
-- Backfill: rows written before this migration recorded only actor_id. One with an actor was
-- made by that person; one without, by a system process, named where the row shows which.
UPDATE "audit_log" SET "actor_kind" = CASE WHEN "actor_id" IS NULL THEN 'system' ELSE 'user' END;--> statement-breakpoint
-- The inbound sync marked its rows: `after.source` on user.* rows, the reason on allowance.synced
-- rows. With an actor (Sync now) the sync is what they acted through; without, the process.
WITH synced AS (
  SELECT "id",
    coalesce(substring("after"->>'source' from '^adapter:(.+)$'), substring("after"->>'reason' from '^Synced from adapter:(.+)$')) AS adapter_id
  FROM "audit_log"
  WHERE ("action" LIKE 'user.%' AND "after"->>'source' LIKE 'adapter:%') OR "action" = 'allowance.synced'
)
UPDATE "audit_log" a SET
  "actor_via" = CASE WHEN a."actor_kind" = 'user' THEN 'adapter_sync:' || s.adapter_id END,
  "actor_process" = CASE WHEN a."actor_kind" = 'system' THEN 'adapter_sync:' || s.adapter_id END
FROM synced s
WHERE a."id" = s."id" AND s.adapter_id IS NOT NULL;--> statement-breakpoint
-- Only the year rollover's step (run nightly, or by an edit of last year) wrote these without an actor.
UPDATE "audit_log" SET "actor_process" = 'year_rollover'
WHERE "actor_kind" = 'system' AND "actor_process" IS NULL AND "action" IN ('allowance.carried_over', 'allowance.created');--> statement-breakpoint
-- Anything else without an actor cannot be traced to a process.
UPDATE "audit_log" SET "actor_process" = 'unknown' WHERE "actor_kind" = 'system' AND "actor_process" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "actor_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_api_key_idx" ON "audit_log" USING btree ("api_key_id") WHERE "audit_log"."api_key_id" is not null;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_kind_known" CHECK ("audit_log"."actor_kind" in ('user', 'api_key', 'system'));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_shape" CHECK (("audit_log"."actor_kind" = 'system' and "audit_log"."actor_process" is not null and "audit_log"."actor_id" is null and "audit_log"."api_key_id" is null and "audit_log"."actor_via" is null)
        or ("audit_log"."actor_kind" = 'user' and "audit_log"."actor_process" is null and "audit_log"."api_key_id" is null)
        or ("audit_log"."actor_kind" = 'api_key' and "audit_log"."actor_process" is null));

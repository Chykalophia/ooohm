import { sql } from "drizzle-orm";
import { executeRows } from "@/db/rows";
import type { Executor } from "@/db/types";

/**
 * Deletes for the integration retention job, each at most `batch` rows per call so no
 * statement holds locks for long. Callers loop until a call deletes fewer than `batch`.
 * A daily job over a small team's history, so these scan rather than keep indexes of
 * their own.
 */

/** Finished (delivered, failed or cancelled) webhook deliveries last touched before `before`. */
export async function pruneFinishedWebhookDeliveries(ex: Executor, before: Date, batch: number): Promise<number> {
  const rows = await executeRows(
    ex,
    sql`
    delete from webhook_deliveries where id in (
      select id from webhook_deliveries where status <> 'pending' and updated_at < ${before.toISOString()}::timestamptz limit ${batch}
    ) returning id
  `,
  );
  return rows.length;
}

/** Finished adapter deliveries last touched before `before`. */
export async function pruneFinishedAdapterDeliveries(ex: Executor, before: Date, batch: number): Promise<number> {
  const rows = await executeRows(
    ex,
    sql`
    delete from adapter_deliveries where id in (
      select id from adapter_deliveries where status <> 'pending' and updated_at < ${before.toISOString()}::timestamptz limit ${batch}
    ) returning id
  `,
  );
  return rows.length;
}

/**
 * Dispatched outbox events written before `before`, except those an adapter still has
 * to deliver. Undispatched events are never pruned, however old.
 */
export async function pruneDispatchedEvents(ex: Executor, before: Date, batch: number): Promise<number> {
  const rows = await executeRows(
    ex,
    sql`
    delete from events_outbox where id in (
      select o.id from events_outbox o
      where o.delivered_at is not null and o.created_at < ${before.toISOString()}::timestamptz
        and not exists (select 1 from adapter_deliveries a where a.event_id = o.id and a.status = 'pending')
      limit ${batch}
    ) returning id
  `,
  );
  return rows.length;
}

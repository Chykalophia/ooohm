import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { eventsOutbox } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

export type OutboxRow = { id: string; companyId: string | null; type: string; payload: unknown; createdAt: Date };

const fields = {
  id: eventsOutbox.id,
  companyId: eventsOutbox.companyId,
  type: eventsOutbox.type,
  payload: eventsOutbox.payload,
  createdAt: eventsOutbox.createdAt,
};

/**
 * Locks up to `limit` undispatched events, oldest first, skipping rows another worker
 * holds (`FOR UPDATE SKIP LOCKED`), so several workers never fan the same event out
 * twice and never wait on each other. The lock lasts until the caller's transaction
 * ends, which must also mark them dispatched.
 */
export async function claimUndispatched(tx: Transaction, limit: number): Promise<OutboxRow[]> {
  return tx
    .select(fields)
    .from(eventsOutbox)
    .where(isNull(eventsOutbox.deliveredAt))
    .orderBy(asc(eventsOutbox.createdAt), asc(eventsOutbox.id))
    .limit(limit)
    .for("update", { skipLocked: true });
}

/** Marks events dispatched (`delivered_at`): their deliveries exist. */
export async function markDispatched(tx: Transaction, ids: readonly string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(eventsOutbox).set({ deliveredAt: at }).where(inArray(eventsOutbox.id, [...ids]));
}

/** Whether `id` is an event of the company. */
export async function companyEventExists(ex: Executor, companyId: string, id: string): Promise<boolean> {
  const [row] = await ex
    .select({ id: eventsOutbox.id })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.id, id), eq(eventsOutbox.companyId, companyId)));
  return row !== undefined;
}

/**
 * A page of the company's events after event `afterId` (exclusive; from the start
 * without it), in `(tx_id, created_at, id)` order: by writing transaction, then write
 * order within it. Served by `events_outbox_company_tx_idx`.
 *
 * Only rows of transactions older than the oldest one still running
 * (`pg_snapshot_xmin`) are returned. Every row a reader could see later then belongs to
 * a transaction with a larger id, so it sorts after the cursor: a transaction that
 * started earlier but commits later can never land behind a reader that has moved on.
 * The comparison runs on the stored values in SQL, so rows written in the same
 * millisecond are neither skipped nor repeated.
 */
export async function listCompanyEvents(
  ex: Executor,
  input: { companyId: string; afterId?: string; limit: number },
): Promise<(OutboxRow & { companyId: string })[]> {
  const after = input.afterId
    ? sql`(${eventsOutbox.txId}, ${eventsOutbox.createdAt}, ${eventsOutbox.id}) > (select o.tx_id, o.created_at, o.id from ${eventsOutbox} o where o.id = ${input.afterId})`
    : undefined;
  const rows = await ex
    .select(fields)
    .from(eventsOutbox)
    .where(
      and(
        eq(eventsOutbox.companyId, input.companyId),
        after,
        sql`${eventsOutbox.txId} < pg_snapshot_xmin(pg_current_snapshot())::text::bigint`,
      ),
    )
    .orderBy(asc(eventsOutbox.txId), asc(eventsOutbox.createdAt), asc(eventsOutbox.id))
    .limit(input.limit);
  return rows as (OutboxRow & { companyId: string })[];
}

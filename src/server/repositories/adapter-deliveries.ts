import { and, eq, sql } from "drizzle-orm";
import { adapterDeliveries } from "@/db/schema";
import { executeRows } from "@/db/rows";
import type { Executor, Transaction } from "@/db/types";

export type NewAdapterDelivery = { companyId: string; adapterId: string; eventId: string; nextAttemptAt: Date };

/** Inserts deliveries, skipping any (adapter, event) pair that already has one. @returns How many were created. */
export async function insertAdapterDeliveries(tx: Transaction, rows: readonly NewAdapterDelivery[]): Promise<number> {
  if (rows.length === 0) return 0;
  const created = await tx
    .insert(adapterDeliveries)
    .values([...rows])
    .onConflictDoNothing({ target: [adapterDeliveries.adapterId, adapterDeliveries.eventId] })
    .returning({ id: adapterDeliveries.id });
  return created.length;
}

/** A claimed adapter delivery, with the outbox event it carries. */
export interface ClaimedAdapterDelivery {
  id: string;
  companyId: string;
  adapterId: string;
  attempts: number;
  event: { id: string; type: string; payload: unknown; createdAt: Date };
}

/**
 * Claims up to `limit` due adapter deliveries, exactly as `claimDueDeliveries` does for
 * webhooks (`SKIP LOCKED`, then a lease until `leaseUntil`).
 */
export async function claimDueAdapterDeliveries(
  ex: Executor,
  input: { now: Date; leaseUntil: Date; limit: number },
): Promise<ClaimedAdapterDelivery[]> {
  const rows = await executeRows<{
    id: string;
    company_id: string;
    adapter_id: string;
    attempts: number;
    event_id: string;
    type: string;
    payload: unknown;
    created_ms: number;
  }>(
    ex,
    sql`
    update adapter_deliveries d
    set attempts = d.attempts + 1, next_attempt_at = ${input.leaseUntil.toISOString()}::timestamptz, last_attempt_at = ${input.now.toISOString()}::timestamptz, updated_at = ${input.now.toISOString()}::timestamptz
    from events_outbox o
    where o.id = d.event_id
      and d.id in (
        select d2.id from adapter_deliveries d2
        where d2.status = 'pending' and d2.next_attempt_at <= ${input.now.toISOString()}::timestamptz
        order by d2.next_attempt_at, d2.id
        limit ${input.limit}
        for update of d2 skip locked
      )
    returning d.id, d.company_id, d.adapter_id, d.attempts, o.id as event_id, o.type, o.payload, (extract(epoch from o.created_at) * 1000)::float8 as created_ms
  `,
  );
  return [...rows].map((r) => ({
    id: r.id,
    companyId: r.company_id,
    adapterId: r.adapter_id,
    attempts: Number(r.attempts),
    event: { id: r.event_id, type: r.type, payload: r.payload, createdAt: new Date(Number(r.created_ms)) },
  }));
}

/**
 * Hands back a claim whose adapter call never completed because the worker is stopping:
 * due again at `now` with its attempt uncounted, so a shutdown never spends the retry
 * budget (as `releaseDeliveryClaims` does for webhooks). Compare-and-set on
 * `(id, attempts, pending)`. @returns Whether it was released.
 */
export async function releaseAdapterClaim(ex: Executor, claim: { id: string; attempts: number }, now: Date): Promise<boolean> {
  const rows = await ex
    .update(adapterDeliveries)
    .set({ attempts: sql`${adapterDeliveries.attempts} - 1`, nextAttemptAt: now, updatedAt: now })
    .where(and(eq(adapterDeliveries.id, claim.id), eq(adapterDeliveries.attempts, claim.attempts), eq(adapterDeliveries.status, "pending")))
    .returning({ id: adapterDeliveries.id });
  return rows.length === 1;
}

export type AdapterOutcome =
  | { status: "delivered"; at: Date }
  | { status: "pending" | "failed"; at: Date; nextAttemptAt: Date; error: string };

/** Records one attempt's outcome if the delivery is still the one claimed (see `recordDeliveryOutcome`). */
export async function recordAdapterOutcome(ex: Executor, claim: { id: string; attempts: number }, outcome: AdapterOutcome): Promise<boolean> {
  const set =
    outcome.status === "delivered"
      ? { status: outcome.status, deliveredAt: outcome.at, lastError: null, updatedAt: outcome.at }
      : { status: outcome.status, nextAttemptAt: outcome.nextAttemptAt, lastError: outcome.error, updatedAt: outcome.at };
  const rows = await ex
    .update(adapterDeliveries)
    .set(set)
    .where(and(eq(adapterDeliveries.id, claim.id), eq(adapterDeliveries.attempts, claim.attempts), eq(adapterDeliveries.status, "pending")))
    .returning({ id: adapterDeliveries.id });
  return rows.length === 1;
}

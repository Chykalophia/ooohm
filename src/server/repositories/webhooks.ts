import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { webhookDeliveries, webhookEndpoints } from "@/db/schema";
import { executeRows } from "@/db/rows";
import type { Executor, Transaction } from "@/db/types";

/** An endpoint as services use it. `secretCiphertext` never leaves the service layer. */
export type WebhookEndpointRow = {
  id: string;
  companyId: string;
  url: string;
  description: string;
  eventTypes: string[];
  secretCiphertext: string;
  enabled: boolean;
  createdAt: Date;
};

const endpointFields = {
  id: webhookEndpoints.id,
  companyId: webhookEndpoints.companyId,
  url: webhookEndpoints.url,
  description: webhookEndpoints.description,
  eventTypes: webhookEndpoints.eventTypes,
  secretCiphertext: webhookEndpoints.secretCiphertext,
  enabled: webhookEndpoints.enabled,
  createdAt: webhookEndpoints.createdAt,
};

const live = (companyId: string) => and(eq(webhookEndpoints.companyId, companyId), isNull(webhookEndpoints.deletedAt));

/**
 * The company's live endpoints, oldest first, each with its latest delivery's status and
 * time (one query; the latest delivery comes from the endpoint's index, newest first).
 */
export async function listEndpoints(ex: Executor, companyId: string) {
  // The outer column is spelled out: drizzle renders `${webhookEndpoints.id}` in a select
  // list unqualified, and a bare "id" would bind to the inner table.
  const latest = sql<{ status: string; at: string } | null>`(
    select json_build_object('status', d.status, 'at', d.created_at)
    from ${webhookDeliveries} d
    where d.endpoint_id = "webhook_endpoints"."id"
    order by d.created_at desc, d.id desc
    limit 1
  )`;
  return ex
    .select({ ...endpointFields, latest })
    .from(webhookEndpoints)
    .where(live(companyId))
    .orderBy(asc(webhookEndpoints.createdAt), asc(webhookEndpoints.id));
}

/** Endpoints of the company not deleted (on or off), or only those `createdBy` made. */
export async function countLiveEndpoints(ex: Executor, companyId: string, createdBy?: string): Promise<number> {
  const [row] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(and(live(companyId), createdBy === undefined ? undefined : eq(webhookEndpoints.createdBy, createdBy)));
  return row?.n ?? 0;
}

/** A live endpoint of the company, or `undefined` (deleted ones read as gone). */
export async function findEndpoint(ex: Executor, companyId: string, id: string): Promise<WebhookEndpointRow | undefined> {
  const [row] = await ex
    .select(endpointFields)
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), live(companyId)));
  return row;
}

/** {@link findEndpoint}, holding a row lock until commit, so two admins' edits apply one after the other. */
export async function lockEndpoint(tx: Transaction, companyId: string, id: string): Promise<WebhookEndpointRow | undefined> {
  const [row] = await tx
    .select(endpointFields)
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), live(companyId)))
    .for("update");
  return row;
}

export async function insertEndpoint(
  tx: Transaction,
  values: { id: string; companyId: string; url: string; description: string; eventTypes: string[]; secretCiphertext: string; createdBy: string },
): Promise<WebhookEndpointRow> {
  const [row] = await tx.insert(webhookEndpoints).values(values).returning(endpointFields);
  return row;
}

export async function updateEndpoint(
  tx: Transaction,
  companyId: string,
  id: string,
  set: Partial<{ url: string; description: string; eventTypes: string[]; secretCiphertext: string; enabled: boolean; deletedAt: Date }>,
): Promise<WebhookEndpointRow> {
  const [row] = await tx
    .update(webhookEndpoints)
    .set(set)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.companyId, companyId)))
    .returning(endpointFields);
  return row;
}

/** Enabled, live endpoints of these companies: where the worker fans events out to. */
export async function listDispatchTargets(ex: Executor, companyIds: readonly string[]) {
  if (companyIds.length === 0) return [];
  return ex
    .select({ id: webhookEndpoints.id, companyId: webhookEndpoints.companyId, eventTypes: webhookEndpoints.eventTypes, createdAt: webhookEndpoints.createdAt })
    .from(webhookEndpoints)
    .where(and(inArray(webhookEndpoints.companyId, [...companyIds]), eq(webhookEndpoints.enabled, true), isNull(webhookEndpoints.deletedAt)));
}

/* ------------------------------------------------------------------ */
/* Deliveries                                                         */
/* ------------------------------------------------------------------ */

export type NewWebhookDelivery = {
  companyId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  body: string;
  nextAttemptAt: Date;
};

/**
 * Inserts deliveries, skipping any (endpoint, event) pair that already has one.
 *
 * @returns The ids of the rows created.
 */
export async function insertDeliveries(tx: Transaction, rows: readonly NewWebhookDelivery[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const created = await tx
    .insert(webhookDeliveries)
    .values([...rows])
    .onConflictDoNothing({ target: [webhookDeliveries.endpointId, webhookDeliveries.eventId] })
    .returning({ id: webhookDeliveries.id });
  return created.map((r) => r.id);
}

const deliveryFields = {
  id: webhookDeliveries.id,
  endpointId: webhookDeliveries.endpointId,
  eventId: webhookDeliveries.eventId,
  eventType: webhookDeliveries.eventType,
  status: webhookDeliveries.status,
  attempts: webhookDeliveries.attempts,
  nextAttemptAt: webhookDeliveries.nextAttemptAt,
  lastAttemptAt: webhookDeliveries.lastAttemptAt,
  lastStatusCode: webhookDeliveries.lastStatusCode,
  lastLatencyMs: webhookDeliveries.lastLatencyMs,
  lastError: webhookDeliveries.lastError,
  deliveredAt: webhookDeliveries.deliveredAt,
  createdAt: webhookDeliveries.createdAt,
};

export type WebhookDeliveryRow = {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: "pending" | "delivered" | "failed" | "cancelled";
  attempts: number;
  nextAttemptAt: Date;
  lastAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
};

/** An endpoint's latest deliveries, newest first. */
export async function listRecentDeliveries(ex: Executor, endpointId: string, limit: number): Promise<WebhookDeliveryRow[]> {
  return ex
    .select(deliveryFields)
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, endpointId))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit);
}

/** One delivery of an endpoint, locked until commit. */
export async function lockDelivery(tx: Transaction, endpointId: string, id: string): Promise<WebhookDeliveryRow | undefined> {
  const [row] = await tx
    .select(deliveryFields)
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.endpointId, endpointId)))
    .for("update");
  return row;
}

/** Queues a finished delivery again from scratch: a fresh attempt count and result, due at `now`. */
export async function requeueDelivery(tx: Transaction, id: string, now: Date): Promise<void> {
  await tx
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      deliveredAt: null,
      lastStatusCode: null,
      lastLatencyMs: null,
      lastError: null,
      lastResponseExcerpt: null,
    })
    .where(eq(webhookDeliveries.id, id));
}

/** Cancels an endpoint's pending deliveries (it was deleted). @returns How many. */
export async function cancelPendingDeliveries(tx: Transaction, endpointId: string): Promise<number> {
  const rows = await tx
    .update(webhookDeliveries)
    .set({ status: "cancelled" })
    .where(and(eq(webhookDeliveries.endpointId, endpointId), eq(webhookDeliveries.status, "pending")))
    .returning({ id: webhookDeliveries.id });
  return rows.length;
}

/** A delivery the worker has claimed, with what it needs to send it. */
export interface ClaimedWebhookDelivery {
  id: string;
  companyId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  body: string;
  /** The attempt count after this claim: the compare-and-set token for recording its outcome. */
  attempts: number;
  url: string;
  secretCiphertext: string;
}

/**
 * Claims up to `limit` due deliveries of enabled, live endpoints, oldest due first, in
 * one statement: `FOR UPDATE ... SKIP LOCKED` picks rows no other worker is claiming,
 * and the update leases them (counts the attempt and moves `next_attempt_at` to
 * `leaseUntil`), so another worker skips them until the lease runs out. A worker that
 * dies mid-attempt leaves the delivery to be retried after the lease: delivery is at
 * least once.
 */
export async function claimDueDeliveries(
  ex: Executor,
  input: { now: Date; leaseUntil: Date; limit: number },
): Promise<ClaimedWebhookDelivery[]> {
  const rows = await executeRows<{
    id: string;
    company_id: string;
    endpoint_id: string;
    event_id: string;
    event_type: string;
    body: string;
    attempts: number;
    url: string;
    secret_ciphertext: string;
  }>(
    ex,
    sql`
    update webhook_deliveries d
    set attempts = d.attempts + 1, next_attempt_at = ${input.leaseUntil.toISOString()}::timestamptz, last_attempt_at = ${input.now.toISOString()}::timestamptz, updated_at = ${input.now.toISOString()}::timestamptz
    from webhook_endpoints e
    where e.id = d.endpoint_id
      and d.id in (
        select d2.id
        from webhook_deliveries d2
        join webhook_endpoints e2 on e2.id = d2.endpoint_id
        where d2.status = 'pending' and d2.next_attempt_at <= ${input.now.toISOString()}::timestamptz and e2.enabled and e2.deleted_at is null
        order by d2.next_attempt_at, d2.id
        limit ${input.limit}
        for update of d2 skip locked
      )
    returning d.id, d.company_id, d.endpoint_id, d.event_id, d.event_type, d.body, d.attempts, e.url, e.secret_ciphertext
  `,
  );
  return [...rows].map((r) => ({
    id: r.id,
    companyId: r.company_id,
    endpointId: r.endpoint_id,
    eventId: r.event_id,
    eventType: r.event_type,
    body: r.body,
    attempts: Number(r.attempts),
    url: r.url,
    secretCiphertext: r.secret_ciphertext,
  }));
}

/**
 * Hands back claims that were never attempted (the worker is stopping): each is due
 * again at `now` with its attempt uncounted, so the next worker takes it at once and the
 * retry budget is untouched. Compare-and-set on `(id, attempts, pending)` like
 * {@link recordDeliveryOutcome}. @returns How many were released.
 */
export async function releaseDeliveryClaims(ex: Executor, claims: readonly { id: string; attempts: number }[], now: Date): Promise<number> {
  if (claims.length === 0) return 0;
  const rows = await ex
    .update(webhookDeliveries)
    .set({ attempts: sql`${webhookDeliveries.attempts} - 1`, nextAttemptAt: now, updatedAt: now })
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        or(...claims.map((c) => and(eq(webhookDeliveries.id, c.id), eq(webhookDeliveries.attempts, c.attempts)))),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return rows.length;
}

export type DeliveryOutcome =
  | { status: "delivered"; at: Date; statusCode: number; latencyMs: number; excerpt: string | null }
  | {
      status: "pending" | "failed";
      at: Date;
      nextAttemptAt: Date;
      statusCode: number | null;
      latencyMs: number | null;
      error: string;
      excerpt: string | null;
    };

/**
 * Records one attempt's outcome, only if the delivery is still the one claimed (pending
 * with the same attempt count): a late result after the lease ran out and another worker
 * took over, or after an admin redelivered it, is dropped.
 *
 * @returns Whether the row was updated.
 */
export async function recordDeliveryOutcome(ex: Executor, claim: { id: string; attempts: number }, outcome: DeliveryOutcome): Promise<boolean> {
  const common = {
    status: outcome.status,
    lastStatusCode: outcome.statusCode,
    lastLatencyMs: outcome.latencyMs,
    lastResponseExcerpt: outcome.excerpt,
    updatedAt: outcome.at,
  };
  const set =
    outcome.status === "delivered"
      ? { ...common, deliveredAt: outcome.at, lastError: null }
      : { ...common, nextAttemptAt: outcome.nextAttemptAt, lastError: outcome.error };
  const rows = await ex
    .update(webhookDeliveries)
    .set(set)
    .where(and(eq(webhookDeliveries.id, claim.id), eq(webhookDeliveries.attempts, claim.attempts), eq(webhookDeliveries.status, "pending")))
    .returning({ id: webhookDeliveries.id });
  return rows.length === 1;
}

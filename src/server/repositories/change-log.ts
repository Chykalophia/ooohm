import { auditLog, eventsOutbox } from "@/db/schema";
import type { Transaction } from "@/db/types";

/** One `audit_log` row: who changed which entity, and its state before and after. */
export interface AuditEntry {
  companyId: string;
  /** The person who made the change; `null` for a system job (e.g. the year rollover). */
  actorId: string | null;
  /** Dotted verb, e.g. `leave_request.approved`. */
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
}

/** One `events_outbox` row for webhooks and future adapters to deliver. */
export interface OutboxEvent {
  companyId: string;
  /** Public event name, e.g. `leave.approved`. */
  type: string;
  payload: unknown;
}

/**
 * Writes the audit trail and the outbox event for one state change.
 *
 * Takes a `Transaction`, not the pool, on purpose: both rows must commit or roll back
 * with the change they describe, so the caller's transaction is the only valid scope.
 */
export async function recordChange(tx: Transaction, change: { audit: AuditEntry; event: OutboxEvent }): Promise<void> {
  await tx.insert(auditLog).values(change.audit);
  await tx.insert(eventsOutbox).values(change.event);
}

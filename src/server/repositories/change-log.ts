import { auditLog, eventsOutbox } from "@/db/schema";
import type { Transaction } from "@/db/types";
import type { ChangeSource } from "@/domain/change-source";
import { eventAttribution } from "@/domain/events";

/** One `audit_log` row: which entity changed, and its state before and after. Who or what changed it is the change's `source`. */
export interface AuditEntry {
  companyId: string;
  /** Dotted verb, e.g. `leave_request.approved`. */
  action: string;
  entityType: string;
  entityId: string;
  /** The person the change is about (a request's requester, an allowance's owner, an edited person), if any. */
  subjectUserId: string | null;
  before: unknown;
  after: unknown;
}

/** One `events_outbox` row for webhooks and adapters to deliver. */
export interface OutboxEvent {
  companyId: string;
  /** Public event name, e.g. `leave.approved`. */
  type: string;
  /** The payload documented for `type`; `actorId` and `actor` are added from the change's source. */
  payload: object;
}

/** The `audit_log` columns that record a source. Also used by the import's bulk audit insert. */
export function sourceColumns(source: ChangeSource) {
  switch (source.kind) {
    case "user":
      return { actorKind: source.kind, actorId: source.userId, apiKeyId: null, actorVia: source.via ?? null, actorProcess: null };
    case "api_key":
      return { actorKind: source.kind, actorId: source.userId, apiKeyId: source.apiKeyId, actorVia: source.via ?? null, actorProcess: null };
    case "system":
      return { actorKind: source.kind, actorId: null, apiKeyId: null, actorVia: null, actorProcess: source.process };
  }
}

/**
 * Writes the audit trail and the outbox event for one state change, both attributed to
 * `source`: the audit row's actor columns, and the payload's `actorId` and `actor`, are
 * written from it here, so an event and its audit row can never disagree about who or
 * what made the change.
 *
 * Takes a `Transaction`, not the pool, on purpose: both rows must commit or roll back
 * with the change they describe, so the caller's transaction is the only valid scope.
 */
export async function recordChange(tx: Transaction, change: { source: ChangeSource; audit: AuditEntry; event: OutboxEvent }): Promise<void> {
  await tx.insert(auditLog).values({ ...change.audit, ...sourceColumns(change.source) });
  await tx.insert(eventsOutbox).values({ ...change.event, payload: { ...change.event.payload, ...eventAttribution(change.source) } });
}

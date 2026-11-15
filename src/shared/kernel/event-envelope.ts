/**
 * The event envelope every integration consumer sees: webhooks, the events API and
 * adapters. It stays outside the integrations module because the adapter port, which
 * `ServiceContext` names, delivers envelopes. No I/O.
 */

/** The envelope version. A change that breaks consumers gets a new version; adding a field does not. */
export const ENVELOPE_VERSION = 1;

/**
 * One event as webhooks, the events API and adapters deliver it (version 1). `data` is
 * the payload documented for `type` in docs/api.md.
 */
export interface EventEnvelope<T = unknown> {
  /** The `events_outbox` id (a generated id for `ping`). Receivers dedupe on it: delivery is at least once. */
  id: string;
  type: string;
  version: typeof ENVELOPE_VERSION;
  /** When the change happened, ISO 8601 in UTC. */
  createdAt: string;
  companyId: string;
  data: T;
}

/** An outbox row as the envelope is built from it. */
export interface OutboxEventSource {
  id: string;
  type: string;
  companyId: string;
  createdAt: Date;
  payload: unknown;
}

/** The public envelope of one outbox event, as webhooks, adapters and `/api/v1/events` deliver it. */
export function buildEnvelope(event: OutboxEventSource): EventEnvelope {
  return {
    id: event.id,
    type: event.type,
    version: ENVELOPE_VERSION,
    createdAt: event.createdAt.toISOString(),
    companyId: event.companyId,
    data: event.payload,
  };
}

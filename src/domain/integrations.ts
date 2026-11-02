/**
 * Pure rules of the integration layer (M6): the event envelope every consumer sees,
 * which events a webhook can subscribe to, the retry schedule shared by webhook and
 * adapter deliveries, and API key scopes. No I/O; the services and the worker apply
 * these.
 */
import { DomainError } from "./errors";
import {
  ADMIN_EVENT_TYPES,
  BALANCE_EVENT_TYPES,
  CALENDAR_FEED_EVENT_TYPES,
  IMPORT_EVENT_TYPES,
  INTEGRATION_EVENT_TYPES,
  LEAVE_EVENT_TYPES,
  LEAVE_REASSIGNED_EVENT_TYPE,
} from "./events";

/* ------------------------------------------------------------------ */
/* Envelope                                                           */
/* ------------------------------------------------------------------ */

/**
 * The public integration guide (docs/api.md in the published source): auth, events,
 * payloads, webhooks and signature verification. Linked from the admin screens and the
 * OpenAPI document, which a deployment's admins can reach where a repository path is not.
 */
export const API_GUIDE_URL = "https://github.com/Chykalophia/ooohm/blob/main/docs/api.md";

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

/** The type of the test event an admin sends to one endpoint. It never enters the outbox. */
export const PING_EVENT_TYPE = "ping";

/** `data` of a `ping` event. */
export interface PingPayload {
  endpointId: string;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                      */
/* ------------------------------------------------------------------ */

/** A group of event types, as the endpoint form shows them. */
export interface EventTypeGroup {
  label: string;
  /** Shown open (and checked by default on a new endpoint): the events most integrations want. */
  common: boolean;
  types: readonly string[];
}

const values = <T extends Record<string, string>>(o: T) => Object.values(o) as string[];

/** Every event type an endpoint may subscribe to, grouped. Every outbox type is here; `ping` is not (it is always sent). */
export const WEBHOOK_EVENT_GROUPS: readonly EventTypeGroup[] = [
  { label: "Leave", common: true, types: [...values(LEAVE_EVENT_TYPES), LEAVE_REASSIGNED_EVENT_TYPE] },
  { label: "Balances", common: true, types: values(BALANCE_EVENT_TYPES) },
  {
    label: "People",
    common: true,
    types: [
      ADMIN_EVENT_TYPES.userCreated,
      ADMIN_EVENT_TYPES.userUpdated,
      ADMIN_EVENT_TYPES.userDeactivated,
      ADMIN_EVENT_TYPES.userReactivated,
      ADMIN_EVENT_TYPES.userInviteResent,
    ],
  },
  {
    label: "Company setup",
    common: false,
    types: values(ADMIN_EVENT_TYPES).filter((t) => !t.startsWith("user.")),
  },
  { label: "Calendar links", common: false, types: values(CALENDAR_FEED_EVENT_TYPES) },
  { label: "Integrations", common: false, types: values(INTEGRATION_EVENT_TYPES) },
  { label: "Imports", common: false, types: values(IMPORT_EVENT_TYPES) },
];

/** Every subscribable event type. */
export const WEBHOOK_EVENT_TYPES: readonly string[] = WEBHOOK_EVENT_GROUPS.flatMap((g) => g.types);

const SUBSCRIBABLE = new Set(WEBHOOK_EVENT_TYPES);

/**
 * The event types an endpoint subscribes to: known types only, each once, in catalogue
 * order.
 *
 * @throws DomainError `invalid_input` when none is chosen or one is unknown.
 */
export function normalizeEventTypes(input: readonly string[]): string[] {
  if (input.length === 0 || input.some((t) => !SUBSCRIBABLE.has(t))) throw new DomainError("invalid_input");
  const chosen = new Set(input);
  return WEBHOOK_EVENT_TYPES.filter((t) => chosen.has(t));
}

/* ------------------------------------------------------------------ */
/* Endpoint and key fields                                            */
/* ------------------------------------------------------------------ */

export const WEBHOOK_DESCRIPTION_MAX_LENGTH = 200;
export const API_KEY_NAME_MAX_LENGTH = 60;
/** Most live (not deleted) webhook endpoints per company: every event fans out to each one. */
export const MAX_WEBHOOK_ENDPOINTS = 20;
/** Most live (not revoked) API keys per company. */
export const MAX_API_KEYS = 50;

function oneLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** A description on one line, at most {@link WEBHOOK_DESCRIPTION_MAX_LENGTH} characters; blank is allowed. */
export function normalizeWebhookDescription(raw: string): string {
  const value = oneLine(raw);
  if (value.length > WEBHOOK_DESCRIPTION_MAX_LENGTH) throw new DomainError("invalid_input");
  return value;
}

/** A key name on one line, 1 to {@link API_KEY_NAME_MAX_LENGTH} characters. */
export function normalizeApiKeyName(raw: string): string {
  const value = oneLine(raw);
  if (value.length === 0 || value.length > API_KEY_NAME_MAX_LENGTH) throw new DomainError("invalid_input");
  return value;
}

/* ------------------------------------------------------------------ */
/* Retries                                                            */
/* ------------------------------------------------------------------ */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Waits before each retry: after the 1st failed attempt 1 minute, after the 7th 24 hours. */
export const RETRY_DELAYS_MS: readonly number[] = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];

/** Attempts in all, the first included. After the last one fails the delivery is `failed`. */
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Each wait is moved by up to this fraction either way, so retries from one outage do not arrive in lockstep. */
export const RETRY_JITTER = 0.1;

/**
 * How long to wait before the next attempt, after `attemptsMade` attempts have failed.
 *
 * @param attemptsMade Attempts so far, at least 1.
 * @param random A number in [0, 1); `Math.random` in the worker, fixed in tests.
 * @returns Milliseconds, or `null` when no attempt is left (the delivery has failed).
 */
export function retryDelayMs(attemptsMade: number, random: number): number | null {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) throw new RangeError(`attemptsMade must be a positive integer, got ${attemptsMade}`);
  if (attemptsMade >= MAX_DELIVERY_ATTEMPTS) return null;
  const base = RETRY_DELAYS_MS[attemptsMade - 1];
  const r = Math.min(Math.max(random, 0), 1);
  return Math.round(base * (1 - RETRY_JITTER + 2 * RETRY_JITTER * r));
}

/* ------------------------------------------------------------------ */
/* API keys                                                           */
/* ------------------------------------------------------------------ */

/**
 * What an API key may do. v1 issues `read` only and every endpoint is read-only; the
 * column holds a list so `write` can be granted later without a migration.
 */
export const API_SCOPES = ["read", "write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** The scopes a new key gets in v1. */
export const DEFAULT_API_SCOPES: readonly ApiScope[] = ["read"];

/**
 * The caller of the REST API: a live key and the company it belongs to. Built from the
 * key lookup, never from request input. `companyId` scopes every query, as `Actor` does
 * for people.
 */
export interface ApiClient {
  readonly keyId: string;
  readonly companyId: string;
  readonly scopes: readonly ApiScope[];
}

export function isApiScope(value: unknown): value is ApiScope {
  return (API_SCOPES as readonly unknown[]).includes(value);
}

/** @throws DomainError `forbidden` when the key lacks `scope`. */
export function assertScope(client: Pick<ApiClient, "scopes">, scope: ApiScope): void {
  if (!client.scopes.includes(scope)) throw new DomainError("forbidden");
}

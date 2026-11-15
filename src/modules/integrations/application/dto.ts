import "server-only";
/**
 * What the integrations use cases return. An endpoint DTO never holds its signing
 * secret (sealed or not), and an API key DTO never holds the key's hash: the field is
 * not there to leak (`tests/unit/modules/integrations/dto.test.ts`).
 */
import type { PageCursor } from "@/domain/paging";
import type { ApiKeyListRow } from "@/modules/integrations/infrastructure/drizzle-api-keys.repository";
import type { WebhookDeliveryRow, WebhookEndpointRow } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";

/** An endpoint as admins see it. */
export interface WebhookEndpointDTO {
  id: string;
  url: string;
  description: string;
  eventTypes: string[];
  enabled: boolean;
  createdAt: Date;
}

export type WebhookDeliveryStatus = WebhookDeliveryRow["status"];

/** An endpoint in the list, with its latest delivery's status. */
export interface WebhookEndpointSummaryDTO extends WebhookEndpointDTO {
  latest: { status: WebhookDeliveryStatus; at: Date } | null;
}

export interface WebhookEndpointListDTO {
  timezone: string;
  endpoints: WebhookEndpointSummaryDTO[];
}

/** One delivery as an endpoint's page lists it: never its body or the endpoint's secret. */
export interface WebhookDeliveryDTO {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

export interface WebhookEndpointPageDTO {
  timezone: string;
  endpoint: WebhookEndpointDTO;
  deliveries: WebhookDeliveryDTO[];
  deliveryPages: { previous: PageCursor | null; next: PageCursor | null };
}

/** A new endpoint, and its signing secret: shown once, then kept sealed. */
export interface CreatedWebhookEndpointDTO {
  endpoint: WebhookEndpointDTO;
  secret: string;
}

/** An API key as the admin screen lists it. */
export interface ApiKeyDTO {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdByName: string | null;
  createdByEmail: string | null;
}

export interface ApiKeyListDTO {
  timezone: string;
  keys: ApiKeyDTO[];
}

/** A new key: the full key is shown once; OOOhm keeps only its hash. */
export interface CreatedApiKeyDTO {
  key: string;
  apiKey: Omit<ApiKeyDTO, "createdByName" | "createdByEmail">;
}

/** An installed adapter with its health, checked now. */
export interface AdapterSummary {
  id: string;
  displayName: string;
  ok: boolean;
  detail: string | null;
  /** Whether it reads people or allowances, so "Sync now" applies. */
  syncs: boolean;
}

export function toWebhookEndpointDTO(row: WebhookEndpointRow): WebhookEndpointDTO {
  return { id: row.id, url: row.url, description: row.description, eventTypes: row.eventTypes, enabled: row.enabled, createdAt: row.createdAt };
}

export function toWebhookDeliveryDTO(row: WebhookDeliveryRow): WebhookDeliveryDTO {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    lastAttemptAt: row.lastAttemptAt,
    lastStatusCode: row.lastStatusCode,
    lastLatencyMs: row.lastLatencyMs,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  };
}

export function toApiKeyDTO(row: ApiKeyListRow): ApiKeyDTO {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdByName: row.createdByName,
    createdByEmail: row.createdByEmail,
  };
}

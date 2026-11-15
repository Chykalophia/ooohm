import "server-only";
/** The audit snapshot and event payload of an API key: never the key or its hash. */
import type { ApiKeyEventPayload, Unattributed } from "@/domain/events";
import type { ApiKeyRow } from "@/modules/integrations/infrastructure/drizzle-api-keys.repository";

export function apiKeySnapshot(row: ApiKeyRow) {
  return { name: row.name, prefix: row.prefix, scopes: row.scopes, revoked: row.revokedAt !== null };
}

/** The payload of `api_key.created` and `api_key.revoked`. */
export function apiKeyEventPayload(row: ApiKeyRow): Unattributed<ApiKeyEventPayload> {
  return { apiKeyId: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes };
}

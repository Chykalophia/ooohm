import "server-only";
/**
 * The integrations module's public API (see README.md): outbound webhooks, REST API
 * keys and the API's reads, installed adapters and their syncs, and the outbox jobs that
 * deliver events. Everything outside the module imports from here only.
 */

// Webhooks (admins).
export { createWebhookEndpoint } from "./application/use-cases/create-webhook-endpoint";
export { updateWebhookEndpoint } from "./application/use-cases/update-webhook-endpoint";
export { setWebhookEndpointEnabled } from "./application/use-cases/set-webhook-endpoint-enabled";
export { rotateWebhookSecret } from "./application/use-cases/rotate-webhook-secret";
export { deleteWebhookEndpoint } from "./application/use-cases/delete-webhook-endpoint";
export { sendWebhookPing } from "./application/use-cases/send-webhook-ping";
export { redeliverWebhook } from "./application/use-cases/redeliver-webhook";
export { listWebhookEndpoints } from "./application/queries/list-webhook-endpoints";
export { getWebhookEndpoint } from "./application/queries/get-webhook-endpoint";

// API keys (admins) and the API's authentication.
export { createApiKey } from "./application/use-cases/create-api-key";
export { revokeApiKey } from "./application/use-cases/revoke-api-key";
export { listApiKeys } from "./application/queries/list-api-keys";
export { authenticateApiKey } from "./application/queries/authenticate-api-key";
export { countLiveApiKeys, countLiveEndpoints } from "./application/queries/count-live-integrations";

// Adapters (admins).
export { listAdapters } from "./application/queries/list-adapters";
export { syncAdapterNow } from "./application/use-cases/sync-adapter-now";
export { applyInboundSync, type InboundSyncInput, type InboundSyncResult, type SyncTrigger } from "./application/inbound-sync";

// The REST API's reads, and its pages (the leave module's API list uses them too).
export { listUsersForApi, type ApiUser } from "./application/queries/list-users-for-api";
export { listLeaveTypesForApi, type ApiLeaveType } from "./application/queries/list-leave-types-for-api";
export { listBalancesForApi, type ApiBalance } from "./application/queries/list-balances-for-api";
export { listHolidaysForApi } from "./application/queries/list-holidays-for-api";
export { listEventsForApi } from "./application/queries/list-events-for-api";
export { decodeCursor, iso, type Page, page } from "./application/api-paging";

// The outbox jobs the background tick runs.
export { dispatchOutboxBatch, type DispatchResult } from "./application/jobs/dispatch-outbox";
export { deliverDueWebhooks, type DeliveryDeps, type DeliveryRunResult } from "./application/jobs/deliver-webhooks";
export { deliverDueAdapterEvents, type AdapterDeliveryDeps, type AdapterRunResult } from "./application/jobs/deliver-to-adapters";

export { canManageAdapters, canManageApiKeys, canManageWebhooks } from "./application/policies";
export {
  API_DEFAULT_PAGE_SIZE,
  API_MAX_PAGE_SIZE,
  DELIVERIES_PAGE_SIZE,
  HEALTH_CHECK_TIMEOUT_MS,
  KEY_USE_STAMP_MS,
  SYNC_READ_TIMEOUT_MS,
  type WebhookEndpointInput,
} from "./application/schemas";
export type {
  AdapterSummary,
  ApiKeyDTO,
  ApiKeyListDTO,
  CreatedApiKeyDTO,
  CreatedWebhookEndpointDTO,
  WebhookDeliveryDTO,
  WebhookDeliveryStatus,
  WebhookEndpointDTO,
  WebhookEndpointListDTO,
  WebhookEndpointPageDTO,
  WebhookEndpointSummaryDTO,
} from "./application/dto";
export { endpointSummary, presentDelivery, type WebhookDeliveryView } from "./ui/webhook-endpoint-presenter";
export {
  API_GUIDE_URL,
  API_KEY_NAME_MAX_LENGTH,
  API_SCOPES,
  assertScope,
  DEFAULT_API_SCOPES,
  isApiScope,
  MAX_API_KEYS,
  MAX_DELIVERY_ATTEMPTS,
  MAX_WEBHOOK_ENDPOINTS,
  normalizeApiKeyName,
  normalizeEventTypes,
  normalizeWebhookDescription,
  PING_EVENT_TYPE,
  RETRY_DELAYS_MS,
  RETRY_JITTER,
  retryDelayMs,
  WEBHOOK_DESCRIPTION_MAX_LENGTH,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_TYPES,
  type ApiClient,
  type ApiScope,
  type EventTypeGroup,
  type PingPayload,
} from "./domain/integrations";

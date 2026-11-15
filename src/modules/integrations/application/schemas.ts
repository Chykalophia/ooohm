import "server-only";
/** What the integrations use cases take in, and the sizes of their pages. */

/** Deliveries shown on an endpoint's page. */
export const DELIVERIES_PAGE_SIZE = 25;

/** The REST API's page sizes. */
export const API_DEFAULT_PAGE_SIZE = 100;
export const API_MAX_PAGE_SIZE = 200;

/** An endpoint form, as typed: the use case normalizes and checks it. */
export interface WebhookEndpointInput {
  url: string;
  description: string;
  eventTypes: readonly string[];
}

/** The longest a health check may take before the screen reports it as not responding. */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;
/** The longest an adapter may take to read people or allowances for a sync. */
export const SYNC_READ_TIMEOUT_MS = 60_000;

/** `last_used_at` is written at most once per this window per key. */
export const KEY_USE_STAMP_MS = 60_000;

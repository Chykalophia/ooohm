# integrations

**Tier 2.** Everything that carries OOOhm's events and data to other systems: outbound webhooks, REST API keys
and the API's reads (`/api/v1`), installed adapters and their syncs, and the outbox jobs that turn
`events_outbox` rows into deliveries. The public contract is docs/api.md.

## Owns

The `webhook_endpoints`, `webhook_deliveries`, `api_keys` and `adapter_deliveries` tables, and the reads of
`events_outbox` that dispatch and `GET /api/v1/events` make (every module writes the outbox through
`recordChange`). Its queries are in `infrastructure/`.

## Public API (`index.ts`)

- Webhooks (admins): `createWebhookEndpoint`, `updateWebhookEndpoint`, `setWebhookEndpointEnabled`,
  `rotateWebhookSecret`, `deleteWebhookEndpoint`, `sendWebhookPing`, `redeliverWebhook`, `listWebhookEndpoints`,
  `getWebhookEndpoint`. Each returns a `ServiceResult`; they fail with `forbidden`, `not_found`, `invalid_input`,
  `insecure_url`, `blocked_address`, `limit_reached` or `conflict`.
- API keys (admins): `createApiKey`, `revokeApiKey`, `listApiKeys` (Results), and `authenticateApiKey` for the
  API handler (`ApiClient | null`). `countLiveApiKeys` and `countLiveEndpoints` take the caller's executor, for
  the person deletion warning.
- Adapters (admins): `listAdapters`, `syncAdapterNow` (Results), and `applyInboundSync`, which writes what an
  adapter returns.
- The API's reads, for an `ApiClient`: `listUsersForApi`, `listLeaveTypesForApi`, `listBalancesForApi`,
  `listHolidaysForApi`, `listEventsForApi` (Results; the handler maps `forbidden` to 403 and `invalid_input` to
  400), and the paging helpers `decodeCursor`, `page`, `iso`, `Page`, which the leave module's API list uses too.
- The background tick's jobs: `dispatchOutboxBatch`, `deliverDueWebhooks`, `deliverDueAdapterEvents`. They report
  counts and never throw for one bad delivery.
- `canManageWebhooks`, `canManageApiKeys`, `canManageAdapters` (admins only), the DTOs, the domain rules
  (`WEBHOOK_EVENT_GROUPS`, `retryDelayMs`, `assertScope`, limits) and `API_GUIDE_URL`.

Every write records `audit_log` and an outbox event (`webhook_endpoint.*`, `webhook_delivery.redelivered`,
`api_key.*`) through `recordAdminChange`, inside `inTransaction`. No DTO holds an API key's hash or a webhook's
signing secret; the secret and the full key are returned once, by the use case that makes them.

## Stays outside, and why

- `src/shared/kernel/event-envelope.ts` (the envelope and `buildEnvelope`) and the adapter port
  (`src/server/integrations/`): `ServiceContext` names the adapter registry, and adapters receive envelopes.
  Moving either in would make every use case's import of `ServiceContext` a cycle through this module.
- `src/shared/kernel/webhook-target.ts`: `ServiceContext` names its `TargetPolicy`, and `src/lib/safe-fetch.ts` uses its
  address checks.
- `src/shared/kernel/events.ts`: the catalog of event types and payloads every module writes.

## Inside

- `domain/integrations.ts`: subscribable event types, limits, the retry schedule, API scopes.
- `application/contracts.ts`: the zod contract of the envelope, `actor` and every event payload in docs/api.md,
  and the webhook request headers. `tests/contracts/` checks recorded samples (`events.json`), what the code
  builds, and signature vectors (`webhook-signatures.json`, computed outside Node) against it, and runs the docs'
  receiver snippet as written. A field added to a payload without the contract fails there.
- `application/use-cases/` and `application/queries/`, one per file; `webhook-changes.ts`, `api-key-changes.ts`,
  `adapter-runs.ts` and `api-paging.ts` hold what several share; `inbound-sync.ts` and `jobs/` the sync and the
  outbox jobs.
- `infrastructure/`: the Drizzle repositories (webhooks, API keys, adapter deliveries, the API's reads, the
  outbox reads).

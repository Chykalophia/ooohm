import "server-only";
/**
 * What the webhook use cases share: the checks before a change to one endpoint, the
 * audit snapshot and event payload of an endpoint (its URL's origin only, never the
 * path or the secret), and the `ping` envelope.
 */
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { buildEnvelope, type EventEnvelope } from "@/domain/event-envelope";
import { INTEGRATION_EVENT_TYPES, type IntegrationEventType, type Unattributed, type WebhookEndpointEventPayload } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { normalizeWebhookUrl, urlOrigin } from "@/domain/webhook-target";
import type { ServiceContext } from "@/server/context";
import { assertActiveAdmin, recordAdminChange } from "@/shared/lib/admin-access";
import { inTransaction } from "@/shared/lib/unit-of-work";
import {
  normalizeEventTypes,
  normalizeWebhookDescription,
  PING_EVENT_TYPE,
  type PingPayload,
} from "@/modules/integrations/domain/integrations";
import { lockEndpoint, type WebhookEndpointRow } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import type { WebhookEndpointInput } from "@/modules/integrations/application/schemas";

/** What the audit row keeps: the origin, not the full URL (paths often carry a token). */
export function endpointSnapshot(row: WebhookEndpointRow) {
  return { urlOrigin: urlOrigin(row.url), description: row.description, eventTypes: row.eventTypes, enabled: row.enabled };
}

/**
 * The payload of a `webhook_endpoint.*` event about `after`. `webhook_endpoint.updated`
 * adds `urlChanged`: the origin alone cannot show a move to another path on the same
 * host (another Slack or Zapier hook), so it says the URL changed, without saying to what.
 */
export function endpointEventPayload(
  type: IntegrationEventType,
  before: WebhookEndpointRow | null,
  after: WebhookEndpointRow,
): Unattributed<WebhookEndpointEventPayload> {
  const base = { endpointId: after.id, ...endpointSnapshot(after) };
  if (type !== INTEGRATION_EVENT_TYPES.webhookEndpointUpdated) return base;
  return { ...base, urlChanged: before !== null && before.url !== after.url };
}

/** Records one change to an endpoint: its audit row and its `webhook_endpoint.*` event. */
export async function recordEndpointChange(
  tx: Transaction,
  actor: Actor,
  type: IntegrationEventType,
  before: WebhookEndpointRow | null,
  after: WebhookEndpointRow,
) {
  const payload = endpointEventPayload(type, before, after);
  const urlChanged = "urlChanged" in payload && payload.urlChanged;
  await recordAdminChange(tx, actor, {
    type,
    entityType: "webhook_endpoint",
    entityId: after.id,
    before: before ? endpointSnapshot(before) : null,
    after: type === INTEGRATION_EVENT_TYPES.webhookEndpointDeleted ? null : { ...endpointSnapshot(after), ...(urlChanged && { urlChanged }) },
    payload,
  });
}

/** An endpoint form's fields, checked: a URL the deployment may call, a one-line description, known event types. */
export function normalizeEndpointInput(ctx: ServiceContext, input: WebhookEndpointInput) {
  return {
    url: normalizeWebhookUrl(input.url, ctx.webhookTargets),
    description: normalizeWebhookDescription(input.description),
    eventTypes: normalizeEventTypes(input.eventTypes),
  };
}

/**
 * Runs `work` on a live endpoint of the actor's company, locked, with the actor checked
 * as an active admin inside the transaction.
 *
 * @throws DomainError `forbidden` or `not_found` (another company's, or deleted).
 */
export async function withEndpoint<T>(ctx: ServiceContext, actor: Actor, id: string, work: (tx: Transaction, row: WebhookEndpointRow) => Promise<T>): Promise<T> {
  if (!isUuid(id)) throw new DomainError("not_found");
  return inTransaction(ctx, async (tx) => {
    await assertActiveAdmin(tx, actor);
    const row = await lockEndpoint(tx, actor.companyId, id);
    if (!row) throw new DomainError("not_found");
    return work(tx, row);
  });
}

/** The test event for one endpoint. It never enters the outbox, so its id is generated. */
export function pingEnvelope(input: { id: string; endpoint: Pick<WebhookEndpointRow, "id" | "companyId">; now: Date }): EventEnvelope<PingPayload> {
  const data: PingPayload = { endpointId: input.endpoint.id, message: "This is a test event from OOOhm." };
  return buildEnvelope({ id: input.id, type: PING_EVENT_TYPE, companyId: input.endpoint.companyId, createdAt: input.now, payload: data }) as EventEnvelope<PingPayload>;
}

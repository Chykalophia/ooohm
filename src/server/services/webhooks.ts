/**
 * Admin use cases for outbound webhooks: endpoints (create, edit, enable/disable,
 * rotate the secret, delete), a test `ping`, and redelivery.
 *
 * Every write follows the admin rules (`assertCanAdminister`, then `assertActiveAdmin`
 * inside the transaction, company scoping) and records `audit_log` + an outbox event
 * (`webhook_endpoint.*`, `webhook_delivery.redelivered`) in the same transaction. Neither
 * ever holds the secret or the URL's path: only its origin.
 *
 * The signing secret is generated here, returned once, and stored sealed with
 * `ctx.secrets` (AES-256-GCM, the endpoint id as additional data). The app never sends
 * a webhook itself: pings and redeliveries are queued, and the outbox worker sends them.
 */
import { randomUUID } from "node:crypto";
import type { Transaction } from "@/db/types";
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { DomainError } from "@/domain/errors";
import { INTEGRATION_EVENT_TYPES, type IntegrationEventType, type Unattributed, type WebhookEndpointEventPayload } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import {
  buildEnvelope,
  MAX_WEBHOOK_ENDPOINTS,
  normalizeEventTypes,
  normalizeWebhookDescription,
  PING_EVENT_TYPE,
  type PingPayload,
} from "@/domain/integrations";
import { normalizeWebhookUrl, urlOrigin } from "@/domain/webhook-target";
import { generateWebhookSecret } from "@/lib/integration-crypto";
import type { ServiceContext } from "@/server/context";
import { findCompany, lockCompany } from "@/server/repositories/companies";
import {
  cancelPendingDeliveries,
  countLiveEndpoints,
  findEndpoint,
  insertDeliveries,
  insertEndpoint,
  listEndpoints,
  listRecentDeliveries,
  lockDelivery,
  lockEndpoint,
  requeueDelivery,
  updateEndpoint,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
} from "@/server/repositories/webhooks";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";

/** Deliveries shown on an endpoint's page. */
export const RECENT_DELIVERIES_LIMIT = 50;

export interface WebhookEndpointInput {
  url: string;
  description: string;
  eventTypes: readonly string[];
}

/** An endpoint as admins see it: never the secret. */
export interface WebhookEndpointView {
  id: string;
  url: string;
  description: string;
  eventTypes: string[];
  enabled: boolean;
  createdAt: Date;
}

function view(row: WebhookEndpointRow): WebhookEndpointView {
  return { id: row.id, url: row.url, description: row.description, eventTypes: row.eventTypes, enabled: row.enabled, createdAt: row.createdAt };
}

/** What the audit row keeps: the origin, not the full URL (paths often carry a token). */
function snapshot(row: WebhookEndpointRow) {
  return { urlOrigin: urlOrigin(row.url), description: row.description, eventTypes: row.eventTypes, enabled: row.enabled };
}

function payload(row: WebhookEndpointRow): Unattributed<WebhookEndpointEventPayload> {
  return { endpointId: row.id, ...snapshot(row) };
}

async function record(tx: Transaction, actor: Actor, type: IntegrationEventType, before: WebhookEndpointRow | null, after: WebhookEndpointRow) {
  // The origin alone cannot show a move to another path on the same host (another Slack
  // or Zapier hook): say that the URL changed, without saying what to.
  const updated = type === INTEGRATION_EVENT_TYPES.webhookEndpointUpdated;
  const urlChanged = updated && before !== null && before.url !== after.url;
  await recordAdminChange(tx, actor, {
    type,
    entityType: "webhook_endpoint",
    entityId: after.id,
    before: before ? snapshot(before) : null,
    after: type === INTEGRATION_EVENT_TYPES.webhookEndpointDeleted ? null : { ...snapshot(after), ...(urlChanged && { urlChanged }) },
    payload: { ...payload(after), ...(updated && { urlChanged }) },
  });
}

function normalizeInput(ctx: ServiceContext, input: WebhookEndpointInput) {
  return {
    url: normalizeWebhookUrl(input.url, ctx.webhookTargets),
    description: normalizeWebhookDescription(input.description),
    eventTypes: normalizeEventTypes(input.eventTypes),
  };
}

/** Runs `work` on a live endpoint of the actor's company, locked, after the admin checks. */
async function withEndpoint<T>(ctx: ServiceContext, actor: Actor, id: string, work: (tx: Transaction, row: WebhookEndpointRow) => Promise<T>): Promise<T> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  return ctx.db.transaction(async (tx) => {
    await assertActiveAdmin(tx, actor);
    const row = await lockEndpoint(tx, actor.companyId, id);
    if (!row) throw new DomainError("not_found");
    return work(tx, row);
  });
}

/**
 * The company's endpoints, oldest first, each with its latest delivery's status.
 *
 * @throws DomainError `forbidden`.
 */
export async function listWebhookEndpoints(ctx: ServiceContext, actor: Actor) {
  assertCanAdminister(actor);
  const [company, rows] = await Promise.all([findCompany(ctx.db, actor.companyId), listEndpoints(ctx.db, actor.companyId)]);
  return {
    timezone: company?.timezone ?? "UTC",
    endpoints: rows.map((r) => ({
      ...view(r),
      latest: r.latest ? { status: r.latest.status as WebhookDeliveryRow["status"], at: new Date(r.latest.at) } : null,
    })),
  };
}

/**
 * One endpoint with its {@link RECENT_DELIVERIES_LIMIT} latest deliveries, newest first.
 *
 * @throws DomainError `forbidden` or `not_found` (another company's, or deleted).
 */
export async function getWebhookEndpoint(ctx: ServiceContext, actor: Actor, id: string) {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  const [company, row] = await Promise.all([findCompany(ctx.db, actor.companyId), findEndpoint(ctx.db, actor.companyId, id)]);
  if (!row) throw new DomainError("not_found");
  return { timezone: company?.timezone ?? "UTC", endpoint: view(row), deliveries: await listRecentDeliveries(ctx.db, id, RECENT_DELIVERIES_LIMIT) };
}

/**
 * Adds an endpoint and generates its signing secret. The secret is returned here only:
 * the caller shows it once, and OOOhm keeps it sealed.
 *
 * Takes the company lock, so the {@link MAX_WEBHOOK_ENDPOINTS} cap holds under
 * concurrency. The endpoint receives events written from now on, never older ones.
 *
 * @throws DomainError `forbidden`, `invalid_input`, `insecure_url`, `blocked_address`,
 *   or `limit_reached`.
 */
export async function createWebhookEndpoint(
  ctx: ServiceContext,
  actor: Actor,
  input: WebhookEndpointInput,
): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
  assertCanAdminister(actor);
  const fields = normalizeInput(ctx, input);
  const id = randomUUID();
  const secret = generateWebhookSecret();
  const secretCiphertext = ctx.secrets.seal(secret, id);
  const row = await ctx.db.transaction(async (tx) => {
    await assertActiveAdmin(tx, actor);
    if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
    if ((await countLiveEndpoints(tx, actor.companyId)) >= MAX_WEBHOOK_ENDPOINTS) throw new DomainError("limit_reached");
    const created = await insertEndpoint(tx, { id, companyId: actor.companyId, ...fields, secretCiphertext, createdBy: actor.id });
    await record(tx, actor, INTEGRATION_EVENT_TYPES.webhookEndpointCreated, null, created);
    return created;
  });
  return { endpoint: view(row), secret };
}

/**
 * Changes an endpoint's URL, description or event types. Records nothing when nothing
 * changed. The secret stays the same.
 *
 * @returns Whether anything changed.
 * @throws DomainError as {@link createWebhookEndpoint} (but not `limit_reached`), or `not_found`.
 */
export async function updateWebhookEndpoint(ctx: ServiceContext, actor: Actor, id: string, input: WebhookEndpointInput): Promise<boolean> {
  assertCanAdminister(actor);
  const fields = normalizeInput(ctx, input);
  return withEndpoint(ctx, actor, id, async (tx, before) => {
    const same =
      before.url === fields.url && before.description === fields.description && before.eventTypes.join() === fields.eventTypes.join();
    if (same) return false;
    const after = await updateEndpoint(tx, actor.companyId, id, fields);
    await record(tx, actor, INTEGRATION_EVENT_TYPES.webhookEndpointUpdated, before, after);
    return true;
  });
}

/**
 * Turns an endpoint on or off. While off it gets no new deliveries; ones already
 * queued wait, and resume when it is turned back on.
 *
 * @returns Whether it changed.
 * @throws DomainError `forbidden` or `not_found`.
 */
export async function setWebhookEndpointEnabled(ctx: ServiceContext, actor: Actor, id: string, enabled: boolean): Promise<boolean> {
  return withEndpoint(ctx, actor, id, async (tx, before) => {
    if (before.enabled === enabled) return false;
    const after = await updateEndpoint(tx, actor.companyId, id, { enabled });
    const type = enabled ? INTEGRATION_EVENT_TYPES.webhookEndpointEnabled : INTEGRATION_EVENT_TYPES.webhookEndpointDisabled;
    await record(tx, actor, type, before, after);
    return true;
  });
}

/**
 * Replaces an endpoint's signing secret at once: every attempt from now on, retries of
 * older events included, is signed with the new one. Returns it once.
 *
 * @throws DomainError `forbidden` or `not_found`.
 */
export async function rotateWebhookSecret(ctx: ServiceContext, actor: Actor, id: string): Promise<{ secret: string }> {
  const secret = generateWebhookSecret();
  await withEndpoint(ctx, actor, id, async (tx, before) => {
    const after = await updateEndpoint(tx, actor.companyId, id, { secretCiphertext: ctx.secrets.seal(secret, id) });
    await record(tx, actor, INTEGRATION_EVENT_TYPES.webhookEndpointSecretRotated, before, after);
  });
  return { secret };
}

/**
 * Deletes an endpoint (soft: deliveries and audit rows keep pointing at it) and cancels
 * its pending deliveries. It disappears from every screen and gets nothing more.
 *
 * @returns How many pending deliveries were cancelled.
 * @throws DomainError `forbidden` or `not_found`.
 */
export async function deleteWebhookEndpoint(ctx: ServiceContext, actor: Actor, id: string): Promise<number> {
  return withEndpoint(ctx, actor, id, async (tx, before) => {
    const after = await updateEndpoint(tx, actor.companyId, id, { deletedAt: ctx.now(), enabled: false });
    const cancelled = await cancelPendingDeliveries(tx, id);
    await record(tx, actor, INTEGRATION_EVENT_TYPES.webhookEndpointDeleted, before, after);
    return cancelled;
  });
}

/**
 * Queues a `ping` to one endpoint, whatever it subscribes to, due at once. The worker
 * signs and sends it like any delivery, with the same retries. Refused for a disabled
 * endpoint, since nothing would send it.
 *
 * @returns The delivery's id.
 * @throws DomainError `forbidden`, `not_found`, or `conflict` (the endpoint is off).
 */
export async function sendWebhookPing(ctx: ServiceContext, actor: Actor, id: string): Promise<string> {
  return withEndpoint(ctx, actor, id, async (tx, row) => {
    if (!row.enabled) throw new DomainError("conflict");
    const now = ctx.now();
    const data: PingPayload = { endpointId: row.id, message: "This is a test event from OOOhm." };
    const envelope = buildEnvelope({ id: randomUUID(), type: PING_EVENT_TYPE, companyId: row.companyId, createdAt: now, payload: data });
    const [deliveryId] = await insertDeliveries(tx, [
      { companyId: row.companyId, endpointId: row.id, eventId: envelope.id, eventType: PING_EVENT_TYPE, body: JSON.stringify(envelope), nextAttemptAt: now },
    ]);
    await record(tx, actor, INTEGRATION_EVENT_TYPES.webhookEndpointPinged, row, row);
    return deliveryId;
  });
}

/**
 * Queues a finished delivery (delivered, failed or cancelled) again, with the same body
 * and event id and a fresh set of attempts, due at once. A delivery still pending is
 * already queued.
 *
 * @throws DomainError `forbidden`, `not_found`, or `conflict` (still pending, or the
 *   endpoint is off).
 */
export async function redeliverWebhook(ctx: ServiceContext, actor: Actor, endpointId: string, deliveryId: string): Promise<void> {
  if (!isUuid(deliveryId)) throw new DomainError("not_found");
  await withEndpoint(ctx, actor, endpointId, async (tx, endpoint) => {
    const delivery = await lockDelivery(tx, endpoint.id, deliveryId);
    if (!delivery) throw new DomainError("not_found");
    if (delivery.status === "pending" || !endpoint.enabled) throw new DomainError("conflict");
    await requeueDelivery(tx, delivery.id, ctx.now());
    await recordAdminChange(tx, actor, {
      type: INTEGRATION_EVENT_TYPES.webhookDeliveryRedelivered,
      entityType: "webhook_delivery",
      entityId: delivery.id,
      before: { status: delivery.status, attempts: delivery.attempts },
      after: { status: "pending", attempts: 0 },
      payload: { endpointId: endpoint.id, deliveryId: delivery.id, eventId: delivery.eventId, eventType: delivery.eventType },
    });
  });
}

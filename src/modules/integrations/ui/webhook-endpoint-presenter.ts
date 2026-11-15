import { formatCount, formatInstantDateTime } from "@/lib/format";
import type { WebhookDeliveryDTO, WebhookEndpointDTO } from "../application/dto";
import { MAX_DELIVERY_ATTEMPTS } from "../domain/integrations";

/** One delivery as the endpoint page lists it. */
export interface WebhookDeliveryView {
  id: string;
  eventType: string;
  status: WebhookDeliveryDTO["status"];
  /** Still pending after a failed attempt: it is being retried. */
  retrying: boolean;
  /** When it was queued, its attempts, the last answer and the next try, as one line. */
  detail: string;
  /** It finished (delivered or failed) and the endpoint is on, so it can be sent again. */
  canRedeliver: boolean;
}

/** The endpoint's state, in a sentence: what it sends, or what being off means. */
export function endpointSummary(endpoint: Pick<WebhookEndpointDTO, "enabled" | "eventTypes" | "createdAt">, timezone: string): string {
  return endpoint.enabled
    ? `Sends ${formatCount(endpoint.eventTypes.length, "kind of event", "kinds of events")}. Added ${formatInstantDateTime(endpoint.createdAt, timezone)}.`
    : "Nothing new is queued for it, and queued deliveries wait until you turn it back on.";
}

export function presentDelivery(d: WebhookDeliveryDTO, timezone: string, endpointEnabled: boolean): WebhookDeliveryView {
  const at = (date: Date) => formatInstantDateTime(date, timezone);
  const retrying = d.status === "pending" && d.attempts > 0 && d.lastError !== null;
  const result =
    d.lastStatusCode !== null ? `HTTP ${d.lastStatusCode}${d.lastLatencyMs !== null ? ` in ${d.lastLatencyMs} ms` : ""}` : d.lastError;
  const detail = [
    at(d.createdAt),
    d.attempts > 0 ? `${formatCount(d.attempts, "attempt", "attempts")} of ${MAX_DELIVERY_ATTEMPTS}` : null,
    result || null,
    retrying ? `next try ${at(d.nextAttemptAt)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return {
    id: d.id,
    eventType: d.eventType,
    status: d.status,
    retrying,
    detail,
    canRedeliver: d.status !== "pending" && d.status !== "cancelled" && endpointEnabled,
  };
}

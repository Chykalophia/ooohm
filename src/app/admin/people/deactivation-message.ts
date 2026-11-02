import type { DeactivationResult } from "@/server/services/admin-people";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the admin reads after deactivating someone: what moved, and any API keys or
 * webhook endpoints that person created, which keep working (they belong to the company)
 * and are worth a look since the person saw each key and signing secret in full.
 */
export function deactivationMessage(result: Pick<DeactivationResult, "requestsReassigned" | "liveApiKeysCreated" | "liveWebhookEndpointsCreated">): string {
  const { requestsReassigned: moved, liveApiKeysCreated: keys, liveWebhookEndpointsCreated: endpoints } = result;
  let message = "Deactivated. They're signed out everywhere.";
  if (moved > 0) message += ` ${count(moved, "pending request", "pending requests")} moved to another approver.`;
  const created = [keys > 0 ? count(keys, "API key", "API keys") : null, endpoints > 0 ? count(endpoints, "webhook endpoint", "webhook endpoints") : null].filter(Boolean);
  if (created.length > 0) {
    const one = keys + endpoints === 1;
    message += ` They created ${created.join(" and ")} that still ${one ? "works" : "work"}. Review ${one ? "it" : "them"} under Admin → Integrations.`;
  }
  return message;
}

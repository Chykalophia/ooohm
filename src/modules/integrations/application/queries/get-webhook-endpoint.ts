import "server-only";
import type { Actor } from "@/domain/actor";
import { DomainError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { isCursorInstant, type PageCursor, readPage } from "@/domain/paging";
import type { ServiceContext } from "@/server/context";
import { findCompany } from "@/modules/organisation";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { findEndpoint, listDeliveries } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import { toWebhookDeliveryDTO, toWebhookEndpointDTO, type WebhookEndpointPageDTO } from "@/modules/integrations/application/dto";
import { canManageWebhooks } from "@/modules/integrations/application/policies";
import { DELIVERIES_PAGE_SIZE } from "@/modules/integrations/application/schemas";

/** A deliveries page's key: `[created_at, id]`. */
const DELIVERY_KEY = [isCursorInstant, isUuid] as const;

/**
 * One endpoint with a page of {@link DELIVERIES_PAGE_SIZE} of its deliveries, newest first.
 *
 * @param page From a previous page's `previous` or `next`; the newest when absent.
 * Fails with `forbidden` or `not_found` (another company's, or deleted).
 */
export async function getWebhookEndpoint(ctx: ServiceContext, actor: Actor, id: string, page?: PageCursor): Promise<ServiceResult<WebhookEndpointPageDTO>> {
  if (!canManageWebhooks(actor)) return err("forbidden");
  if (!isUuid(id)) return err("not_found");
  return attempt(async () => {
    const [company, row] = await Promise.all([findCompany(ctx.db, actor.companyId), findEndpoint(ctx.db, actor.companyId, id)]);
    if (!row) throw new DomainError("not_found");
    const deliveries = await readPage({
      cursor: page,
      size: DELIVERIES_PAGE_SIZE,
      checks: DELIVERY_KEY,
      read: (request, limit) => listDeliveries(ctx.db, id, limit, request),
      keyOf: (d) => [d.cursor, d.id],
    });
    return {
      timezone: company?.timezone ?? "UTC",
      endpoint: toWebhookEndpointDTO(row),
      deliveries: deliveries.items.map(toWebhookDeliveryDTO),
      deliveryPages: { previous: deliveries.previous, next: deliveries.next },
    };
  });
}

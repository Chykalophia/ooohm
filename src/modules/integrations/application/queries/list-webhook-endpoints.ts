import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { findCompany } from "@/modules/organisation";
import { attempt, err, type ServiceResult } from "@/shared/lib/result";
import { listEndpoints } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";
import { toWebhookEndpointDTO, type WebhookDeliveryStatus, type WebhookEndpointListDTO } from "@/modules/integrations/application/dto";
import { canManageWebhooks } from "@/modules/integrations/application/policies";

/** The company's endpoints, oldest first, each with its latest delivery's status. Fails with `forbidden`. */
export async function listWebhookEndpoints(ctx: ServiceContext, actor: Actor): Promise<ServiceResult<WebhookEndpointListDTO>> {
  if (!canManageWebhooks(actor)) return err("forbidden");
  return attempt(async () => {
    const [company, rows] = await Promise.all([findCompany(ctx.db, actor.companyId), listEndpoints(ctx.db, actor.companyId)]);
    return {
      timezone: company?.timezone ?? "UTC",
      endpoints: rows.map((r) => ({
        ...toWebhookEndpointDTO(r),
        latest: r.latest ? { status: r.latest.status as WebhookDeliveryStatus, at: new Date(r.latest.at) } : null,
      })),
    };
  });
}

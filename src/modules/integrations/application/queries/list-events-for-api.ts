import "server-only";
import { DomainError } from "@/shared/kernel/errors";
import { buildEnvelope, type EventEnvelope } from "@/shared/kernel/event-envelope";
import { isUuid } from "@/shared/kernel/uuid";
import type { ServiceContext } from "@/server/context";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { type ApiClient, assertScope } from "@/modules/integrations/domain/integrations";
import { companyEventExists, listCompanyEvents } from "@/modules/integrations/infrastructure/drizzle-outbox.repository";

/**
 * The company's events after event `after` (from the oldest kept without it), in the
 * order a poller can rely on: an event never appears behind one already returned (see
 * `listCompanyEvents`). Pass the last `id` you processed as `after`. Two queries with a
 * cursor (it must be an event of the company), one without.
 *
 * Fails with `forbidden`, or `invalid_input` when `after` is not an event of the
 * company (or was pruned by retention; start again without it).
 */
export async function listEventsForApi(
  ctx: ServiceContext,
  client: ApiClient,
  q: { after?: string; limit: number },
): Promise<ServiceResult<{ data: EventEnvelope[]; hasMore: boolean }>> {
  return attempt(async () => {
    assertScope(client, "read");
    if (q.after !== undefined && (!isUuid(q.after) || !(await companyEventExists(ctx.db, client.companyId, q.after)))) {
      throw new DomainError("invalid_input", "`after` is not an event of this company.");
    }
    const rows = await listCompanyEvents(ctx.db, { companyId: client.companyId, afterId: q.after, limit: q.limit + 1 });
    const more = rows.length > q.limit;
    return { data: (more ? rows.slice(0, q.limit) : rows).map(buildEnvelope), hasMore: more };
  });
}

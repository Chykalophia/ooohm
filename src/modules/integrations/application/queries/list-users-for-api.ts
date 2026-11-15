import "server-only";
import type { ServiceContext } from "@/server/context";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { type ApiClient, assertScope } from "@/modules/integrations/domain/integrations";
import { listUsersPage } from "@/modules/integrations/infrastructure/drizzle-api-reads.repository";
import { decodeCursor, type Page, page } from "@/modules/integrations/application/api-paging";

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  department: { id: string; name: string } | null;
  managerId: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
}

/**
 * People of the company (active and not), by id. One query. Every API read checks the
 * `read` scope first and scopes its query by the key's company: an id from another
 * company reads as absent. Fails with `forbidden` or `invalid_input` (a bad cursor).
 */
export async function listUsersForApi(ctx: ServiceContext, client: ApiClient, q: { cursor?: string | undefined; limit: number }): Promise<ServiceResult<Page<ApiUser>>> {
  return attempt(async () => {
    assertScope(client, "read");
    const after = q.cursor ? decodeCursor(q.cursor, ["id"]).id : undefined;
    const rows = await listUsersPage(ctx.db, { companyId: client.companyId, afterId: after, limit: q.limit });
    return page(
      rows,
      q.limit,
      (r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        department: r.departmentId ? { id: r.departmentId, name: r.departmentName ?? "" } : null,
        managerId: r.managerId,
        role: r.role,
        isActive: r.isActive,
        createdAt: r.createdAt.toISOString(),
      }),
      (r) => ({ id: r.id }),
    );
  });
}

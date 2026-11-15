import "server-only";
import type { ServiceContext } from "@/server/context";
import { listAllLeaveTypes } from "@/modules/organisation";
import { attempt, type ServiceResult } from "@/shared/lib/result";
import { type ApiClient, assertScope } from "@/modules/integrations/domain/integrations";

export interface ApiLeaveType {
  id: string;
  code: string;
  name: string;
  color: string;
  isPaid: boolean;
  countsAgainstAllowance: boolean;
  defaultAllowanceDays: number | null;
  carryoverEnabled: boolean;
  carryoverMaxDays: number | null;
  sortOrder: number;
  archived: boolean;
}

/** Every leave type, archived ones too (flagged), in display order. One query. Fails with `forbidden`. */
export async function listLeaveTypesForApi(ctx: ServiceContext, client: ApiClient): Promise<ServiceResult<{ data: ApiLeaveType[] }>> {
  return attempt(async () => {
    assertScope(client, "read");
    const rows = await listAllLeaveTypes(ctx.db, client.companyId);
    return {
      data: rows.map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        color: t.color,
        isPaid: t.isPaid,
        countsAgainstAllowance: t.countsAgainstAllowance,
        // The type's own setting, which the API lists as such (not a person's default).
        defaultAllowanceDays: t.defaultAllowanceDays,
        carryoverEnabled: t.carryoverEnabled,
        carryoverMaxDays: t.carryoverMaxDays,
        sortOrder: t.sortOrder,
        archived: t.archivedAt !== null,
      })),
    };
  });
}

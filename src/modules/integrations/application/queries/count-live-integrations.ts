import "server-only";
import type { Executor } from "@/db/types";
import { countLiveApiKeys as countKeys } from "@/modules/integrations/infrastructure/drizzle-api-keys.repository";
import { countLiveEndpoints as countEndpoints } from "@/modules/integrations/infrastructure/drizzle-webhooks.repository";

/**
 * Unrevoked API keys of the company, or only those `createdBy` made: what deleting a
 * person warns about. Takes the caller's executor, so it reads inside its transaction.
 */
export function countLiveApiKeys(ex: Executor, companyId: string, createdBy?: string): Promise<number> {
  return countKeys(ex, companyId, createdBy);
}

/** Webhook endpoints of the company not deleted (on or off), or only those `createdBy` made. */
export function countLiveEndpoints(ex: Executor, companyId: string, createdBy?: string): Promise<number> {
  return countEndpoints(ex, companyId, createdBy);
}

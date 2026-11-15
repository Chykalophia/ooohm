import "server-only";
import { sameDigest } from "@/lib/integration-crypto";
import { hashToken } from "@/lib/token-hash";
import type { ServiceContext } from "@/server/context";
import { type ApiClient, isApiScope } from "@/modules/integrations/domain/integrations";
import { stampKeyUsed } from "@/modules/integrations/infrastructure/drizzle-api-keys.repository";
import { findLiveApiKeyByHash } from "@/shared/lib/db/pre-tenant";
import { forTenant } from "@/shared/lib/tenant";
import { KEY_USE_STAMP_MS } from "@/modules/integrations/application/schemas";

/**
 * The client a well-formed key (see `apiKeyFromAuthorization`) authenticates, or `null`
 * when it is unknown or revoked. One index probe on the key's hash, plus, at most once a
 * minute per key, a write of `last_used_at` alongside nothing else. The probe is a
 * pre-tenant read (ADR-0004): it finds the key's company, and the stamp, like everything
 * the client then reads, runs for that company. The stored hash is compared again in
 * constant time; the key is never logged.
 *
 * It returns `null` rather than a failure: the API handler answers 401 for both.
 */
export async function authenticateApiKey(ctx: ServiceContext, key: string): Promise<ApiClient | null> {
  const hash = hashToken(key);
  const row = await findLiveApiKeyByHash(ctx.db, hash);
  if (!row || !sameDigest(row.keyHash, hash)) return null;
  const now = ctx.now();
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= KEY_USE_STAMP_MS) {
    await stampKeyUsed(forTenant(ctx, row.companyId).db, row.id, now, new Date(now.getTime() - KEY_USE_STAMP_MS));
  }
  return { keyId: row.id, companyId: row.companyId, scopes: row.scopes.filter(isApiScope) };
}

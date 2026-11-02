/**
 * REST API keys: what admins do with them (list, create, revoke) and how a request's
 * key is checked.
 *
 * A key is `ooohm_` and 32 random bytes; only its SHA-256 is stored, so it is shown once,
 * at creation. Keys belong to the company, not to the admin who made them: deactivating
 * that admin does not revoke them (revoke them on the API keys screen). Creating and
 * revoking write `audit_log` + an outbox event (`api_key.*`) in the same transaction;
 * neither ever holds the key or its hash.
 */
import type { Actor } from "@/domain/actor";
import { assertCanAdminister } from "@/domain/admin-permissions";
import { DomainError } from "@/domain/errors";
import { type ApiKeyEventPayload, INTEGRATION_EVENT_TYPES, type Unattributed } from "@/domain/events";
import { isUuid } from "@/domain/ids";
import { type ApiClient, DEFAULT_API_SCOPES, isApiScope, MAX_API_KEYS, normalizeApiKeyName } from "@/domain/integrations";
import { generateApiKey, hashApiKey, sameDigest } from "@/lib/integration-crypto";
import type { ServiceContext } from "@/server/context";
import {
  type ApiKeyRow,
  countLiveApiKeys,
  findLiveKeyByHash,
  insertApiKey,
  listApiKeys as listApiKeyRows,
  lockApiKey,
  revokeApiKey as revokeApiKeyRow,
  stampKeyUsed,
} from "@/server/repositories/api-keys";
import { findCompany, lockCompany } from "@/server/repositories/companies";
import { assertActiveAdmin, recordAdminChange } from "./admin-access";

/** `last_used_at` is written at most once per this window per key. */
export const KEY_USE_STAMP_MS = 60_000;

function snapshot(row: ApiKeyRow) {
  return { name: row.name, prefix: row.prefix, scopes: row.scopes, revoked: row.revokedAt !== null };
}

function payload(row: ApiKeyRow): Unattributed<ApiKeyEventPayload> {
  return { apiKeyId: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes };
}

/**
 * The company's keys (live first, then newest), with who created each. Never a hash.
 *
 * @throws DomainError `forbidden`.
 */
export async function listApiKeys(ctx: ServiceContext, actor: Actor) {
  assertCanAdminister(actor);
  const [company, keys] = await Promise.all([findCompany(ctx.db, actor.companyId), listApiKeyRows(ctx.db, actor.companyId)]);
  return { timezone: company?.timezone ?? "UTC", keys };
}

/**
 * Creates a `read` key. The full key is returned here only.
 *
 * Takes the company lock, so the {@link MAX_API_KEYS} cap holds under concurrency.
 *
 * @throws DomainError `forbidden`, `invalid_input` (name), or `limit_reached`.
 */
export async function createApiKey(ctx: ServiceContext, actor: Actor, input: { name: string }): Promise<{ key: string; apiKey: ApiKeyRow }> {
  assertCanAdminister(actor);
  const name = normalizeApiKeyName(input.name);
  const generated = generateApiKey();
  const apiKey = await ctx.db.transaction(async (tx) => {
    await assertActiveAdmin(tx, actor);
    if (!(await lockCompany(tx, actor.companyId))) throw new DomainError("no_company");
    if ((await countLiveApiKeys(tx, actor.companyId)) >= MAX_API_KEYS) throw new DomainError("limit_reached");
    const row = await insertApiKey(tx, {
      companyId: actor.companyId,
      name,
      prefix: generated.prefix,
      keyHash: generated.hash,
      scopes: [...DEFAULT_API_SCOPES],
      createdBy: actor.id,
    });
    await recordAdminChange(tx, actor, {
      type: INTEGRATION_EVENT_TYPES.apiKeyCreated,
      entityType: "api_key",
      entityId: row.id,
      before: null,
      after: snapshot(row),
      payload: payload(row),
    });
    return row;
  });
  return { key: generated.key, apiKey };
}

/**
 * Revokes a key at once: its next request gets 401. Revoking a revoked key changes and
 * records nothing.
 *
 * @returns Whether it was live.
 * @throws DomainError `forbidden` or `not_found`.
 */
export async function revokeApiKey(ctx: ServiceContext, actor: Actor, id: string): Promise<boolean> {
  assertCanAdminister(actor);
  if (!isUuid(id)) throw new DomainError("not_found");
  return ctx.db.transaction(async (tx) => {
    await assertActiveAdmin(tx, actor);
    const before = await lockApiKey(tx, actor.companyId, id);
    if (!before) throw new DomainError("not_found");
    if (before.revokedAt) return false;
    const after = await revokeApiKeyRow(tx, id, ctx.now());
    await recordAdminChange(tx, actor, {
      type: INTEGRATION_EVENT_TYPES.apiKeyRevoked,
      entityType: "api_key",
      entityId: id,
      before: snapshot(before),
      after: snapshot(after),
      payload: payload(after),
    });
    return true;
  });
}

/**
 * The client a well-formed key (see `apiKeyFromAuthorization`) authenticates, or `null`
 * when it is unknown or revoked. One index probe on the key's hash, plus, at most once a
 * minute per key, a write of `last_used_at` alongside nothing else. The stored hash is
 * compared again in constant time; the key is never logged.
 */
export async function authenticateApiKey(ctx: ServiceContext, key: string): Promise<ApiClient | null> {
  const hash = hashApiKey(key);
  const row = await findLiveKeyByHash(ctx.db, hash);
  if (!row || !sameDigest(row.keyHash, hash)) return null;
  const now = ctx.now();
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= KEY_USE_STAMP_MS) {
    await stampKeyUsed(ctx.db, row.id, now, new Date(now.getTime() - KEY_USE_STAMP_MS));
  }
  return { keyId: row.id, companyId: row.companyId, scopes: row.scopes.filter(isApiScope) };
}

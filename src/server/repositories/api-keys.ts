import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { apiKeys, user } from "@/db/schema";
import type { Executor, Transaction } from "@/db/types";

/** A key as the admin screen shows it. Never the hash. */
export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

const fields = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
};

const creator = alias(user, "creator");

/** The company's keys, live first, then newest first, with who created each. One query. */
export async function listApiKeys(ex: Executor, companyId: string) {
  return ex
    .select({ ...fields, createdByName: creator.name, createdByEmail: creator.email })
    .from(apiKeys)
    .leftJoin(creator, eq(creator.id, apiKeys.createdBy))
    .where(eq(apiKeys.companyId, companyId))
    .orderBy(sql`${apiKeys.revokedAt} is not null`, desc(apiKeys.createdAt), desc(apiKeys.id));
}

/** Unrevoked keys of the company, or only those `createdBy` made. */
export async function countLiveApiKeys(ex: Executor, companyId: string, createdBy?: string): Promise<number> {
  const [row] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(apiKeys)
    .where(and(eq(apiKeys.companyId, companyId), isNull(apiKeys.revokedAt), createdBy === undefined ? undefined : eq(apiKeys.createdBy, createdBy)));
  return row?.n ?? 0;
}

export async function insertApiKey(
  tx: Transaction,
  values: { companyId: string; name: string; prefix: string; keyHash: string; scopes: string[]; createdBy: string },
): Promise<ApiKeyRow> {
  const [row] = await tx.insert(apiKeys).values(values).returning(fields);
  return row;
}

/** A key of the company, locked until commit. */
export async function lockApiKey(tx: Transaction, companyId: string, id: string): Promise<ApiKeyRow | undefined> {
  const [row] = await tx
    .select(fields)
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.companyId, companyId)))
    .for("update");
  return row;
}

export async function revokeApiKey(tx: Transaction, id: string, at: Date): Promise<ApiKeyRow> {
  const [row] = await tx.update(apiKeys).set({ revokedAt: at }).where(eq(apiKeys.id, id)).returning(fields);
  return row;
}

/**
 * The live key with this hash, or `undefined`: one probe on the unique hash index.
 * Returns the stored hash too, so the caller can compare it in constant time.
 */
export async function findLiveKeyByHash(ex: Executor, keyHash: string) {
  const [row] = await ex
    .select({ id: apiKeys.id, companyId: apiKeys.companyId, scopes: apiKeys.scopes, keyHash: apiKeys.keyHash, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)));
  return row;
}

/** Sets `last_used_at` unless it is already newer than `staleBefore`, so a busy key writes at most once a window. */
export async function stampKeyUsed(ex: Executor, id: string, at: Date, staleBefore: Date): Promise<void> {
  await ex
    .update(apiKeys)
    .set({ lastUsedAt: at })
    .where(and(eq(apiKeys.id, id), or(isNull(apiKeys.lastUsedAt), lte(apiKeys.lastUsedAt, staleBefore))));
}

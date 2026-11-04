import { asc, eq } from "drizzle-orm";
import { passkey } from "@/db/schema";
import type { Executor } from "@/db/types";

/** A person's passkeys as the account page lists them, oldest first. Never the key material. */
export async function listPasskeysOf(ex: Executor, userId: string) {
  return ex
    .select({
      id: passkey.id,
      name: passkey.name,
      createdAt: passkey.createdAt,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
    })
    .from(passkey)
    .where(eq(passkey.userId, userId))
    .orderBy(asc(passkey.createdAt), asc(passkey.id));
}

/** Whether the person has added any passkey. */
export async function hasPasskeyOf(ex: Executor, userId: string): Promise<boolean> {
  const [row] = await ex.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId)).limit(1);
  return row !== undefined;
}

import "server-only";
import type { Actor } from "@/shared/kernel/actor";
import type { ServiceContext } from "@/server/context";
import { hasPasskeyOf } from "@/modules/people/infrastructure/drizzle-passkeys.repository";

/** Whether the actor has added a passkey yet; Home suggests one until they have. One read; never fails. */
export async function hasPasskey(ctx: ServiceContext, actor: Actor): Promise<boolean> {
  return hasPasskeyOf(ctx.db, actor.id);
}

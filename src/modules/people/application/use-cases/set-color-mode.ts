import "server-only";
import { forTenant } from "@/shared/lib/tenant";
import type { Actor } from "@/shared/kernel/actor";
import type { ColorMode } from "@/shared/kernel/color-mode";
import type { ServiceContext } from "@/server/context";
import { updateColorMode } from "@/modules/people/infrastructure/drizzle-people.repository";
import { err, ok, type ServiceResult } from "@/shared/lib/result";

/**
 * Saves the actor's colour mode (light, dark or automatic). A display preference of
 * their own, so no audit row or event (see `@/shared/kernel/color-mode`).
 *
 * Fails with `forbidden` for a deactivated or deleted account.
 */
export async function setColorMode(ctx: ServiceContext, actor: Actor, colorMode: ColorMode): Promise<ServiceResult<void>> {
  ctx = forTenant(ctx, actor.companyId);
  return (await updateColorMode(ctx.db, actor.companyId, actor.id, colorMode)) ? ok(undefined) : err("forbidden");
}

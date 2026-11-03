/**
 * The look every page renders with. Read on each request by the root layout, before
 * anyone is signed in, so it never fails: with no company yet, or no database to ask,
 * the default look applies.
 */
import { type Appearance, DEFAULT_APPEARANCE, readAppearance } from "@/domain/appearance";
import type { ServiceContext } from "@/server/context";
import { log } from "@/lib/log";
import { findDeploymentAppearance } from "@/server/repositories/companies";

export async function getAppearance(ctx: ServiceContext): Promise<Appearance> {
  try {
    const stored = await findDeploymentAppearance(ctx.db);
    return stored ? readAppearance(stored) : DEFAULT_APPEARANCE;
  } catch (err) {
    log.warn({ err }, "appearance_read_failed");
    return DEFAULT_APPEARANCE;
  }
}

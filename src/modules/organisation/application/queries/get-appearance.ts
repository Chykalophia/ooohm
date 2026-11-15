import "server-only";
import { type Appearance, DEFAULT_APPEARANCE, readAppearance } from "@/shared/kernel/appearance";
import type { ServiceContext } from "@/server/context";
import { log } from "@/lib/log";
import { findDeploymentBrand } from "@/shared/lib/db/pre-tenant";

/**
 * The look every page renders with. Read on each request by the root layout, before
 * anyone is signed in, so it never fails: with no company yet, or no database to ask,
 * the default look applies. A pre-tenant read (ADR-0004): v1 runs one company per
 * deployment; with several, the oldest one's look applies.
 */
export async function getAppearance(ctx: ServiceContext): Promise<Appearance> {
  try {
    const stored = await findDeploymentBrand(ctx.db);
    return stored ? readAppearance(stored) : DEFAULT_APPEARANCE;
  } catch (err) {
    log.warn({ err }, "appearance_read_failed");
    return DEFAULT_APPEARANCE;
  }
}

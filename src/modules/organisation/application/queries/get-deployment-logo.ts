import "server-only";
import type { LogoRef } from "@/shared/kernel/company-logo";
import type { ServiceContext } from "@/server/context";
import { log } from "@/lib/log";
import { findDeploymentBrand } from "@/modules/organisation/infrastructure/drizzle-companies.repository";
import { logoRef } from "@/modules/organisation/application/logo-ref";

/** `getCompanyLogo` for pages that render before anyone is known: the deployment company's. Never fails. */
export async function getDeploymentLogo(ctx: ServiceContext): Promise<LogoRef | null> {
  try {
    return logoRef(await findDeploymentBrand(ctx.db));
  } catch (err) {
    log.warn({ err }, "logo_read_failed");
    return null;
  }
}

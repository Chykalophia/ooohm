import "server-only";
import type { LogoRef } from "@/domain/company-logo";
import type { ServiceContext } from "@/server/context";
import { log } from "@/lib/log";
import { findCompany } from "@/modules/organisation/infrastructure/drizzle-companies.repository";
import { logoRef } from "@/modules/organisation/application/logo-ref";

/**
 * The company's logo as the header draws it, or null for the OOOhm mark. Like
 * `getAppearance` it never fails the page: if it cannot be read, the mark shows.
 */
export async function getCompanyLogo(ctx: ServiceContext, companyId: string): Promise<LogoRef | null> {
  try {
    return logoRef(await findCompany(ctx.db, companyId));
  } catch (err) {
    log.warn({ err }, "logo_read_failed");
    return null;
  }
}

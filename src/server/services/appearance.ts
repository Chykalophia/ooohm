/**
 * The look every page renders with. Read on each request by the root layout, before
 * anyone is signed in, so it never fails: with no company yet, or no database to ask,
 * the default look applies.
 */
import { type Appearance, DEFAULT_APPEARANCE, readAppearance } from "@/domain/appearance";
import { type LogoRef, appLogoRef, parseLogoFile, readStoredLogo } from "@/domain/company-logo";
import type { ServiceContext } from "@/server/context";
import { log } from "@/lib/log";
import { type CompanyRow, findCompany, findDeploymentAppearance, findDeploymentBrand, findLogoFile } from "@/server/repositories/companies";

export async function getAppearance(ctx: ServiceContext): Promise<Appearance> {
  try {
    const stored = await findDeploymentAppearance(ctx.db);
    return stored ? readAppearance(stored) : DEFAULT_APPEARANCE;
  } catch (err) {
    log.warn({ err }, "appearance_read_failed");
    return DEFAULT_APPEARANCE;
  }
}

function logoRef(company: Pick<CompanyRow, "name" | "logoSha256" | "logoType" | "logoWidth" | "logoHeight"> | undefined): LogoRef | null {
  const logo = company ? readStoredLogo(company) : null;
  return company && logo ? appLogoRef(logo, company.name) : null;
}

/**
 * The company's logo as the header draws it, or null for the OOOhm mark. Like
 * {@link getAppearance} it never fails the page: if it cannot be read, the mark shows.
 */
export async function getCompanyLogo(ctx: ServiceContext, companyId: string): Promise<LogoRef | null> {
  try {
    return logoRef(await findCompany(ctx.db, companyId));
  } catch (err) {
    log.warn({ err }, "logo_read_failed");
    return null;
  }
}

/** {@link getCompanyLogo} for pages that render before anyone is known: the deployment company's. */
export async function getDeploymentLogo(ctx: ServiceContext): Promise<LogoRef | null> {
  try {
    return logoRef(await findDeploymentBrand(ctx.db));
  } catch (err) {
    log.warn({ err }, "logo_read_failed");
    return null;
  }
}

/**
 * The stored logo a URL names (`<sha256>.<ext>`), or null when none is stored under it
 * with that type. Public, like the favicon: a logo is shown before sign-in and in emails.
 */
export async function getLogoFile(ctx: ServiceContext, file: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const wanted = parseLogoFile(file);
  if (!wanted) return null;
  const found = await findLogoFile(ctx.db, wanted.sha256);
  return found && found.contentType === wanted.contentType ? found : null;
}
